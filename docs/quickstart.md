# Quick Start

Launch Ultravisor Lab and bring up your first database engine, Ultravisor instance, and stack.

## Prerequisites

- **Node.js** with the built-in `node:sqlite` module (the lab persists its state through `meadow-connection-sqlite`, which sits on `node:sqlite`).
- **Docker** - the `docker` CLI on your `PATH`, with the daemon running. The lab boots without Docker but cannot provision anything until the daemon is reachable.
- **Docker Compose** - the `docker compose` v2 plugin (preferred) or the `docker-compose` v1 standalone, required only for the [Stacks](stacks.md) feature.
- A **Retold monorepo checkout** if you intend to launch stacks or beacons that build images from local source. See [Configuration](configuration.md#monorepo-root) for how the checkout root is resolved.

## Install

From the `ultravisor-lab` module directory:

```bash
npm install
```

## Start The Lab

```bash
npm start
```

This runs `node lab.js`. You will see:

```
  Ultravisor Lab
  http://127.0.0.1:44443/
  data dir: /path/to/ultravisor-lab/data
  Ctrl-C to stop.
```

The lab binds to `127.0.0.1:44443` and opens your browser automatically. Press `Ctrl-C` to stop it; shutdown stops the reconcile loop and closes the state store gracefully.

To bind a different port or interface, or to skip the browser launch:

```bash
node lab.js --port 5555 --host 0.0.0.0 --no-open
```

> If you have not built the browser bundle yet, the server serves the raw source UI from `web/html` and logs `Browser bundle not built yet. Run: npm run build-bundle`. The UI still works; run `npm run build-bundle` to serve the optimized bundle from `web/dist` instead.

## Confirm Docker Is Visible

Open the **Overview** page in the UI. It shows a Docker status badge sourced from `docker version`. If Docker is unavailable the badge says so, and provisioning buttons will fail until the daemon is up. You can also check from the command line:

```bash
curl http://127.0.0.1:44443/api/lab/status
```

The response includes a `Docker` block (`Available`, `Version`) and per-entity `Counts`.

## Bring Up A DB Engine

1. Open **DB Engines** in the sidebar.
2. Click to add an engine, pick a type (e.g. **MySQL**), and accept the suggested host port (MySQL defaults to a suggestion starting at `33306`).
3. Submit. The engine card appears in `provisioning` state while the lab pulls the image and runs the container, then flips to `running` once the engine accepts connections.
4. With the engine running, create a database inside it from the engine's card.

Behind the scenes the lab ensures the `ultravisor-lab` docker network exists, pulls the engine image, runs the container on that network with a stable hostname, and polls a health check until ready. See [DB Engines](db-engines.md) for the full lifecycle.

## Run An Ultravisor Instance

1. Open **Ultravisor** in the sidebar.
2. Add an instance: give it a name and a host port (the default Ultravisor API port inside the container is `54321`).
3. Submit. The lab builds the `ultravisor` image on demand (the first build can take a few minutes), renders an `.ultravisor.json` config into the instance's data directory, runs the container, waits for the API, and loads the bundled seed-dataset operations into its library.

Once the instance is `running`, its web UI is reachable at the host port you chose, and the seed-dataset operations are available to run.

## Attach A Beacon

1. Open **Ultravisor Beacons** in the sidebar.
2. Choose a beacon type. The lab lists every Retold module on your system that publishes a `retoldBeacon` stanza - for example **Retold DataBeacon**.
3. Fill in the name, port, and target Ultravisor, then submit. The lab builds the beacon's container image, runs it on the shared network wired to the Ultravisor, and waits for it to come up.

See [Ultravisor & Beacons](ultravisor-beacons.md) for beacon types, container vs. host-process runtime, and the rebuild / source-build controls.

## Or Launch A Whole Stack

Rather than wiring services one at a time, launch a complete topology:

1. Open **Stacks** in the sidebar and start a new stack from a preset. Nine presets ship in the box - from a single promiscuous Ultravisor to a full data platform with databases, an auth beacon, multiple databeacons, and a mapper UI.
2. Fill in the stack's inputs (data directory, monorepo root, secrets, ports). Required secrets must be non-empty or preflight will block the launch.
3. Run **preflight** to check host ports, folders, build contexts, and images, then **launch**. The lab resolves the spec, compiles it to a `docker-compose.yml`, and runs `docker compose up -d --build`.
4. Watch the stack's status roll up from `starting` to `running` as containers become healthy.

See [Stacks](stacks.md) for the spec format, input templating, preflight checks, and a tour of each bundled preset.

## Clean Up

When you are done, the lab can tear down everything it manages in dependency order (beacons, then Ultravisor instances, then DB engines, then history rows) and record a teardown event. The underlying remove paths stop and remove the containers and child processes. You can also remove individual entities from their cards, or take a stack down with `docker compose down` from its detail view.

## Next Steps

- [Configuration](configuration.md) - change the port, data directory, or monorepo root
- [Architecture](architecture.md) - understand the services and the reconcile loop
- [Stacks](stacks.md) - the declarative deployment system and presets
- [REST API](api.md) - drive the lab from scripts
