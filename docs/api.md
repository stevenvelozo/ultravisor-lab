# REST API

The lab serves a JSON REST API from the same Orator (Restify) server that serves the browser bundle, all under `/api/lab/`. The browser UI consumes these endpoints; you can also call them directly from scripts. Every response carries an `X-Ultravisor-Lab` version header.

Base URL (default): `http://127.0.0.1:44443`

This page lists the routes the server actually registers, grouped by area. Request and response shapes are documented in each feature page.

## System

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/health` | Liveness probe (`Product`, `Version`, `ServerTime`). |
| `GET` | `/api/lab/branding` | Operator-supplied branding for the UI (see [Configuration](configuration.md#embedding-the-lab)). |
| `GET` | `/api/lab/status` | Dashboard snapshot: Docker probe, per-entity counts, last reconcile result. |
| `POST` | `/api/lab/reconcile` | Run a reconcile pass on demand. |
| `POST` | `/api/lab/teardown` | Remove every managed entity in dependency order; returns a summary. |

## Entities (generic lists)

Read-only list endpoints over the state-store tables. The `UltravisorInstance` projection scrubs the bootstrap auth secret.

| Method | Path | Table |
|---|---|---|
| `GET` | `/api/lab/db-engines` | `DBEngine` |
| `GET` | `/api/lab/databases` | `Database` |
| `GET` | `/api/lab/ultravisor-instances` | `UltravisorInstance` |
| `GET` | `/api/lab/beacons` | `Beacon` |
| `GET` | `/api/lab/facto-instances` | `FactoInstance` |
| `GET` | `/api/lab/ingestion-jobs` | `IngestionJob` |

(The single-entity, create, and lifecycle routes below are registered by the per-feature route modules and take precedence over these generic lists.)

## DB Engines

| Method | Path |
|---|---|
| `GET` | `/api/lab/db-engine-types` |
| `GET` | `/api/lab/db-engine-types/:engineType/next-port` |
| `GET` | `/api/lab/db-engines/:id` |
| `POST` | `/api/lab/db-engines` |
| `POST` | `/api/lab/db-engines/:id/start` |
| `POST` | `/api/lab/db-engines/:id/stop` |
| `DELETE` | `/api/lab/db-engines/:id` |
| `GET` | `/api/lab/db-engines/:id/connection-info` |
| `GET` | `/api/lab/db-engines/:id/logs` |
| `POST` | `/api/lab/db-engines/:id/databases` |
| `DELETE` | `/api/lab/db-engines/:id/databases/:dbid` |

See [DB Engines](db-engines.md).

## Ultravisor Instances

| Method | Path |
|---|---|
| `GET` | `/api/lab/ultravisor-instances/next-port` |
| `GET` | `/api/lab/ultravisor-instances/:id` |
| `GET` | `/api/lab/ultravisor-instances/:id/operations` |
| `POST` | `/api/lab/ultravisor-instances` |
| `POST` | `/api/lab/ultravisor-instances/:id/bootstrap-admin` |
| `POST` | `/api/lab/ultravisor-instances/:id/start` |
| `POST` | `/api/lab/ultravisor-instances/:id/stop` |
| `DELETE` | `/api/lab/ultravisor-instances/:id` |
| `GET` | `/api/lab/ultravisor-instances/:id/logs` |
| `GET` | `/api/lab/ultravisor-instances/:id/runs/:run` |
| `POST` | `/api/lab/ultravisor-instances/:id/persistence-beacon` |
| `GET` | `/api/lab/ultravisor-instances/:id/persistence-status` |
| `GET` | `/api/lab/ultravisor-instances/:id/queue-snapshot` |

See [Ultravisor & Beacons](ultravisor-beacons.md).

## Beacons

| Method | Path |
|---|---|
| `GET` | `/api/lab/beacon-types` |
| `GET` | `/api/lab/beacons/next-port` |
| `GET` | `/api/lab/beacons/:id` |
| `GET` | `/api/lab/beacons/:id/connections` |
| `POST` | `/api/lab/beacons` |
| `POST` | `/api/lab/beacons/:id/start` |
| `POST` | `/api/lab/beacons/:id/stop` |
| `POST` | `/api/lab/beacons/:id/rebuild` |
| `POST` | `/api/lab/beacons/:id/build-source` |
| `DELETE` | `/api/lab/beacons/:id` |
| `GET` | `/api/lab/beacons/:id/logs` |

## Stacks

| Method | Path |
|---|---|
| `GET` | `/api/lab/stack-presets` |
| `GET` | `/api/lab/stack-presets/:presetHash` |
| `GET` | `/api/lab/stacks` |
| `GET` | `/api/lab/stacks/:hash` |
| `POST` | `/api/lab/stacks` |
| `POST` | `/api/lab/stacks/clone-preset/:presetHash` |
| `DELETE` | `/api/lab/stacks/:hash` |
| `POST` | `/api/lab/stacks/:hash/preflight` |
| `POST` | `/api/lab/stacks/:hash/up` |
| `POST` | `/api/lab/stacks/:hash/down` |
| `GET` | `/api/lab/stacks/:hash/status` |
| `GET` | `/api/lab/stacks/:hash/compose-yaml` |
| `POST` | `/api/lab/stacks/:hash/clear-launch-lock` |
| `GET` | `/api/lab/stacks/:hash/init` |
| `POST` | `/api/lab/stacks/:hash/init/run` |
| `GET` | `/api/lab/operations` |
| `GET` | `/api/lab/operations/:hash` |

See [Stacks](stacks.md).

## Seed Datasets

| Method | Path |
|---|---|
| `GET` | `/api/lab/seed-datasets` |
| `GET` | `/api/lab/seed-datasets/:hash` |
| `POST` | `/api/lab/seed-datasets/:hash/run` |
| `POST` | `/api/lab/seed-datasets/:hash/seed-to-engine` |

## Beacon Exercises

| Method | Path |
|---|---|
| `GET` | `/api/lab/beacon-exercises` |
| `GET` | `/api/lab/beacon-exercises/:hash` |
| `POST` | `/api/lab/beacon-exercises/:hash/run` |
| `GET` | `/api/lab/beacon-exercise-runs` |
| `GET` | `/api/lab/beacon-exercise-runs/:id` |
| `GET` | `/api/lab/beacon-exercise-runs/:id/events` |
| `POST` | `/api/lab/beacon-exercise-runs/:id/cancel` |

## Operation Exercises

| Method | Path |
|---|---|
| `GET` | `/api/lab/operation-exercises` |
| `GET` | `/api/lab/operation-exercises/:hash` |
| `POST` | `/api/lab/operation-exercises/:hash/run` |
| `GET` | `/api/lab/operation-exercise-runs` |
| `GET` | `/api/lab/operation-exercise-runs/:id` |
| `GET` | `/api/lab/operation-exercise-runs/:id/events` |
| `POST` | `/api/lab/operation-exercise-runs/:id/cancel` |

See [Seed Data & Exercises](seed-data-and-exercises.md).

## Events

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/events` | The infrastructure event timeline. |
| `POST` | `/api/lab/events` | Record an event. |

## Static Assets

Anything outside `/api/lab/` is served as a static asset: the browser bundle's `index.html`, plus `/js/*` and `/css/*` from `web/dist` (or the `web/html` + `web/css` source tree when the bundle is not built).
