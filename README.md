# Ultravisor Lab

> Provision dockerized engines, beacons, and Ultravisor instances from one web UI

Ultravisor Lab is a local web application for standing up the moving parts of a Retold data platform on Docker and keeping them supervised. From a single browser UI it provisions database-engine containers, builds and runs Ultravisor instances, attaches beacons to them, and launches whole multi-container topologies described as declarative *stacks*. It is the hands-on counterpart to the headless [Ultravisor Suite Harness](https://github.com/stevenvelozo/ultravisor-suite-harness): where the harness runs a fixed pipeline and exits, the lab is an interactive bench you keep open while you build and test.

The lab process itself runs on the host (Node.js). Everything it *manages* runs in Docker containers. The lab drives the `docker` CLI directly — it pulls images, builds images on demand from the Retold modules in your monorepo checkout, runs containers on a shared docker network, and reflects their live state back into the UI.

## What It Does

- **Dockerized DB engines** — create MySQL, PostgreSQL, SQL Server, MongoDB, Apache Solr, or DGraph containers with one form. The lab pulls the image, runs the container, polls until the engine accepts connections, and lets you create and drop databases inside it.
- **Ultravisor instances** — build the `ultravisor` image on demand and run a container per instance, with a rendered config, a bind-mounted data directory, and an auto-loaded operation library. Optional secured (non-promiscuous) mode mints a bootstrap auth secret.
- **Beacons** — discover every Retold module that publishes a `retoldBeacon` stanza (`retold-databeacon`, `retold-facto`, `retold-remote`, `meadow-integration`, `orator-conversion`, `retold-content-system`, `ultravisor-auth-beacon`), build its container image, and run it wired to an Ultravisor.
- **Stacks** — describe a multi-container topology (databases + Ultravisor + beacons + apps) as a JSON spec with templated inputs. The lab resolves the inputs, preflights the host, compiles the spec to a `docker-compose.yml`, and runs `docker compose up`. Nine presets ship in the box.
- **Seed data & exercises** — packaged datasets you can load through a running Ultravisor, plus queue and operation load-test fixtures that drive synthetic workloads and assert on the results.

## Requirements

- **Node.js** with the built-in `node:sqlite` module (used through `meadow-connection-sqlite` for lab state).
- **Docker** — the `docker` CLI on your `PATH`. The lab boots without Docker but cannot provision anything until it is available.
- **Docker Compose** — the `docker compose` v2 plugin (preferred) or the `docker-compose` v1 standalone (fallback) for the Stacks feature.
- A **Retold monorepo checkout** when launching stacks or beacons that build from local source. The lab auto-detects the checkout root or reads it from `RETOLD_MONOREPO_ROOT`.

## Install & Run

From the module directory:

```bash
npm install
npm start
```

`npm start` runs `node lab.js`, which starts the web server on `http://127.0.0.1:44443/` and opens your browser. Press `Ctrl-C` to stop; the lab shuts the reconcile loop and state store down gracefully.

You can also run it through the `bin`:

```bash
npx ultravisor-lab
```

### Launch options

```bash
node lab.js [options]

  --port <N>     Bind to port N (default: 44443).
  --host <ADDR>  Bind to interface ADDR (default: 127.0.0.1).
  --no-open      Do not auto-open the browser.
  --open         Auto-open the browser (default).
  --help, -h     Print this help.
```

By default the server binds to `127.0.0.1`, so it is not reachable from the local network unless you opt in with `--host 0.0.0.0`.

### Building the browser bundle

The web UI is a Pict browser application. During development the server falls back to serving the raw `web/html` + `web/css` source tree, and logs a warning that the bundle is missing. To build and serve the optimized bundle:

```bash
npm run build-bundle
```

This runs the brand step (`npm run brand`) and then `npx quack build && npx quack copy`, producing `web/dist/`. When `web/dist/` exists the server serves it in preference to the source tree.

## Documentation

Full documentation lives under [`docs/`](docs/README.md):

- [Overview](docs/README.md) — what the lab is and how its pieces fit together
- [Quick Start](docs/quickstart.md) — launch the lab and bring up your first engine, Ultravisor, and stack
- [Configuration](docs/configuration.md) — ports, data directory, monorepo root, library exports
- [Architecture](docs/architecture.md) — process topology, services, state model, reconcile loop
- [DB Engines](docs/db-engines.md) — the supported engines and their lifecycle
- [Ultravisor & Beacons](docs/ultravisor-beacons.md) — instance and beacon supervision
- [Stacks](docs/stacks.md) — the declarative compose-backed deployment system and bundled presets
- [Web UI](docs/web-ui.md) — the navigation and views
- [Seed Data & Exercises](docs/seed-data-and-exercises.md) — datasets and load-test fixtures
- [REST API](docs/api.md) — the HTTP endpoints the UI consumes

## Related Modules

Ultravisor Lab is part of the [Retold](https://github.com/fable-retold) ecosystem.

| Module | Owner | Role in the lab |
|---|---|---|
| [Ultravisor](https://stevenvelozo.github.io/ultravisor/) | stevenvelozo | Workflow / operation supervisor the lab builds, runs, and seeds |
| [Ultravisor Beacon](https://stevenvelozo.github.io/ultravisor-beacon/) | stevenvelozo | Capability-provider host the lab uses for provider-mode beacons |
| [Retold Facto](https://fable-retold.github.io/retold-facto/) | stevenvelozo | A beacon type the lab can provision (data-movement / ETL) |
| [Retold Remote](https://fable-retold.github.io/retold-remote/) | stevenvelozo | A beacon type the lab can provision (file browse / serve) |
| [Retold DataBeacon](https://fable-retold.github.io/retold-databeacon/) | fable-retold | A beacon type the lab can provision (REST over remote databases) |
| [Meadow](https://fable-retold.github.io/meadow/) | fable-retold | Data-access layer; `meadow-connection-sqlite` backs lab state |
| [Orator](https://fable-retold.github.io/orator/) | fable-retold | The HTTP server (Restify) hosting the lab's REST API + static bundle |
| [Pict](https://fable-retold.github.io/pict/) | fable-retold | MVC framework powering the browser application |
| [Fable](https://fable-retold.github.io/fable/) | fable-retold | Service-provider / DI core every lab service extends |

## License

MIT — Steven Velozo &lt;steven@velozo.com&gt;
