# Architecture

How Ultravisor Lab is put together: the process topology, the service layer, the state model, and the reconcile loop that keeps the lab's view of the world honest.

## Process Topology

The lab runs as a single Node.js process on the host. It does not run inside Docker. Everything it *manages* runs in Docker containers that the lab creates by shelling out to the `docker` CLI.

```
┌──────────────────────────────────────────────────────────────┐
│ host                                                          │
│                                                               │
│  ultravisor-lab  (node lab.js, http://127.0.0.1:44443)        │
│     │  Fable → Orator (Restify) → lab services → REST + UI    │
│     │  state: data/lab.db (SQLite)                            │
│     │                                                         │
│     │  docker CLI                                             │
│     ▼                                                         │
│  ┌──────────── docker network: ultravisor-lab ────────────┐  │
│  │                                                         │  │
│  │   mysql-…  /  postgres-…   (DB engine containers)       │  │
│  │   lab-ultravisor-<id>      (Ultravisor containers)      │  │
│  │   <beacon>-…               (beacon containers)          │  │
│  │                                                         │  │
│  │   …plus, for Stacks, a compose project per stack with   │  │
│  │   its own network: stack-<hash>                         │  │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Containers on the shared `ultravisor-lab` network resolve each other by container name via Docker's embedded DNS, so a beacon can reach an Ultravisor container at `http://lab-ultravisor-5:54321`. Every service is also mapped to a host port so the browser UI and external tools can reach it on `127.0.0.1`.

Stacks are different: each launched stack is its own `docker compose` project (`stack-<hash>`) with its own compose-managed network, independent of the shared `ultravisor-lab` network. See [Stacks](stacks.md).

## The Transport Stack

`lab.js` is the entry point. It parses argv, auto-detects the monorepo root, installs crash logging, and calls `setupLabServer()` (`source/web_server/Lab-Server-Setup.js`), which composes the runtime in this order:

1. **Fable** — the service-provider / dependency-injection core. Product identity and log streams are configured here.
2. **Orator (Restify)** — the HTTP server. The lab registers the Restify body parser and query parser, adds an `X-Ultravisor-Lab` version header, and binds explicitly to the configured host.
3. **Lab services** — every manager and store is registered as a Fable service and collected into a `Core` bag.
4. **REST routes** — ten route modules register their endpoints against Orator's server.
5. **Static bundle** — the built `web/dist` bundle is served if present; otherwise the `web/html` source tree is served as a development fallback.

`setupLabServer()` is also exported from the package (`require('ultravisor-lab').setupLabServer`) so a downstream app can embed the lab with its own branding, extra stack-preset directories, or extra operation directories. See [Configuration](configuration.md#embedding-the-lab).

## The Service Layer

Every lab capability is a Fable service extending `fable-serviceproviderbase`. The services divide into stores, low-level managers, entity managers, the stack pipeline, and supporting services.

### Stores

| Service | Responsibility |
|---|---|
| `LabStateStore` | All lab state in SQLite at `data/lab.db`. Synchronous `list / getById / insert / update / remove / recordEvent / listEvents`. Schema comes from `model/MeadowModel-Lab.json`. |
| `LabStackStore` | Stack-spec persistence (the `Stack` table is canonical, mirrored to `data/stacks/<Hash>.json`) plus the read-only preset library scanned from `source/stacks/presets/`. |
| `LabOperationStore` | Init-operation graphs for stacks, loaded from operation directories. |

### Low-level managers

| Service | Responsibility |
|---|---|
| `LabDockerManager` | Thin wrapper around the `docker` CLI: `probe`, `inspect`, `imageExists`, `ensureImage` (build-on-demand with progress heartbeats), `ensureNetwork`, `connectToNetwork`, `pull`, `run`, `exec`, `start`, `stop`, `rm`, `rmi`, `logs`. |
| `LabProcessSupervisor` | Spawns and tracks detached child processes (host-process beacon runtime), redirecting stdout/stderr to log files and persisting PIDs to `data/pids/`. |
| `LabPortAllocator` | Finds the next free host port, skipping ports already owned by other lab entities and ports bound at the OS level. Drives the create-form port suggestions. |
| `LabReconcileLoop` | Periodically reconciles state-store rows against live Docker / process state (see below). |

### Entity managers

| Service | Responsibility |
|---|---|
| `LabDBEngineManager` | DB-engine lifecycle (create / start / stop / remove) plus database create / drop. Delegates engine-specific commands to per-engine adapters in `source/services/engines/`. |
| `LabUltravisorManager` | Ultravisor instance lifecycle: builds the image, renders config, provisions and loads the operation library, and exposes operation register / trigger / manifest / persistence-assignment helpers. |
| `LabBeaconManager` | Generic beacon lifecycle, forking on the row's `Runtime` (`container` vs `process`). Renders per-beacon config, polls for readiness, and exposes rebuild / source-build switches. |
| `LabBeaconContainerManager` | Builds and runs beacon container images (npm or source flavor) on the shared network. |
| `LabBeaconTypeRegistry` | Discovers beacon types from each Retold module's `retoldBeacon` package stanza, plus one lab-local synthetic beacon. |

### The stack pipeline

The Stacks feature is built as five cooperating services (see [Stacks](stacks.md) for detail):

| Service | Responsibility |
|---|---|
| `LabStackStore` | Persistence + preset library (above). |
| `LabStackResolver` | Pure-functional `${input.X}` / `${component.Y.host}` / `${env.X}` substitution and unresolved-reference reporting. |
| `LabStackPreflight` | Probes the resolved spec against host folders, ports, build contexts, images, and required secrets; produces a ready / warnings / blockers report. |
| `LabStackComposer` | Renders the resolved spec into a `docker-compose.yml` under `data/stacks/<Hash>/`. |
| `LabStackLifecycle` | Drives `docker compose up / down / ps / logs`, with CLI detection (v2 plugin, v1 fallback) and a per-stack launch lock. |
| `LabStackInitializer` | Runs a stack's optional init operation against its launched Ultravisor. |

### Supporting services

| Service | Responsibility |
|---|---|
| `LabSeedDatasetManager` | Catalogs packaged seed datasets and provisions / runs their operations. |
| `LabBeaconExerciseManager` | Queue load-test fixtures: provisions synthetic beacons, drives workloads, taps the queue WebSocket, asserts on results. |
| `LabOperationExerciseManager` | Operation-graph load-test fixtures against a shared synthetic-beacon fleet. |
| `LabLifecycle` | One-shot `teardown()` that removes every managed entity in dependency order. |

## State Model

State lives in SQLite at `data/lab.db`. The schema is defined once in `model/MeadowModel-Lab.json` and applied through `meadow-connection-sqlite`; column additions are handled by forward-only migrations on boot. The tables:

| Table | Holds |
|---|---|
| `DBEngine` | Dockerized database-engine containers (type, ports, container id, image tag, root credentials, status). |
| `Database` | Databases created inside an engine. |
| `UltravisorInstance` | Ultravisor containers (port, container id, image, runtime, config path, secured-mode fields, persistence-beacon assignment). |
| `Beacon` | Beacons (type, port, runtime, build source, container id, image, target Ultravisor, config, admission overrides). |
| `FactoInstance` | Facto-instance rows (table present in the schema). |
| `IngestionJob` | Seed-run / ingestion history (parsed / loaded / verified counts, run hash). |
| `InfrastructureEvent` | The flat event log that feeds the UI timeline. |
| `BeaconExerciseRun` / `BeaconExerciseEvent` | Queue-exercise runs and their captured envelopes. |
| `OperationExerciseRun` / `OperationExerciseEvent` | Operation-exercise runs and their captured events. |
| `Stack` | Stack specs (full spec JSON, per-launch input values, status), canonical over the file mirror. |

Lab state is internal, so the schema deliberately omits the usual Retold audit columns (`IDUser` / `GUID` / `Deleted`).

Beyond the database, the lab writes to the data directory:

- `data/beacons/<id>/` — rendered `config.json` (bind-mounted into container-mode beacons) and process logs.
- `data/ultravisors/<id>/` — rendered `.ultravisor.json`, the `operations/` library, the file store, and run staging; bind-mounted to `/app/data` in the container.
- `data/stacks/<Hash>.json` and `data/stacks/<Hash>/docker-compose.yml` — stack mirror and generated compose file.
- `data/pids/` — PID files for host-process beacons.
- `data/crash-<timestamp>.log` — written on an uncaught exception or unhandled rejection before the process exits.

## Boot Sequence & The Reconcile Loop

On startup `setupLabServer()`:

1. Initializes the state store and process supervisor, and records a `lab-started` event.
2. Assembles the `Core` bag, brings Orator up, wires routes, and starts listening.
3. Migrates any legacy beacon / Ultravisor rows to container runtime and clears their stale PIDs.
4. Snapshots which rows claimed `running` before the previous shutdown.
5. Probes Docker; if available, ensures the `ultravisor-lab` network exists and re-attaches existing containers to it.
6. Runs the reconcile loop once so the first UI render is fresh, then starts it on an interval.
7. Auto-restarts everything that was running before shutdown, in dependency order — DB engines first, then Ultravisor instances, then beacons.

The **reconcile loop** (`LabReconcileLoop`) runs once at boot and then every 15 seconds. It compares each tracked row's recorded status against reality — `docker inspect` for container-backed entities, PID liveness for host-process ones. Drift (a row says `running` but the container or process is gone) is recorded as a `warning` infrastructure event; the loop never silently mutates rows out from under the UI. Its last result is exposed at `GET /api/lab/status` and can be triggered on demand with `POST /api/lab/reconcile`.

## Crash Handling

The lab installs `uncaughtException` and `unhandledRejection` handlers that write the stack trace to `data/crash-<timestamp>.log` and exit with code `70`. The rationale is explicit in the code: Node's contract after an uncaught exception is that the process is in an undefined state, so limping on risks corrupted DB writes or zombie state — a visible crash with a log file next to it is the safer outcome.

## See Also

- [Configuration](configuration.md) — the knobs `setupLabServer()` accepts
- [DB Engines](db-engines.md), [Ultravisor & Beacons](ultravisor-beacons.md), [Stacks](stacks.md) — the entity managers in depth
- [REST API](api.md) — the endpoints the route layer registers
