# Seed Data & Exercises

Beyond provisioning infrastructure, the lab ships fixtures for *driving* it: packaged seed datasets you can load through a running Ultravisor, and two families of load-test exercises that put synthetic workloads through the queue and assert on the results.

## Seed Datasets

Seed datasets are packaged sample data plus an Ultravisor operation that loads them. They live under `seed_datasets/<name>/`, each with a `manifest.json` (catalog metadata), an `operation.json` (the Ultravisor operation graph), and the data files. `LabSeedDatasetManager` scans this directory at boot to build an in-memory catalog.

The bundled datasets:

| Dataset | What it is |
|---|---|
| **People** | A flat 60-person directory - the simplest fixture, one entity, no foreign keys. |
| **Books & Authors** | A small literary catalog - 8 authors and 12 books linked by `IDAuthor`; a minimal two-entity fixture. |
| **City Demographics** | A 50-city demographic profile (population, density, median age/income, region) that correlates with the transit and weather datasets. |
| **Weather Stations** | 50 city weather stations with ~12 monthly readings each. |
| **Transit Systems** | 50 transit agencies with 3-5 routes each. |
| **City Dashboard** | An empty target entity - an ETL destination for the correlated city data. |

### How loading works

When an Ultravisor instance is created, the lab automatically writes each dataset's `operation.json` (with path placeholders substituted) into the instance's operation-library directory, so the operations are visible and runnable in the Ultravisor's own web UI. The lab's **Seed Data** view then lets you run a dataset against a chosen Ultravisor: it (re-)registers the operation (idempotent, upserts by hash), executes it asynchronously, and records an `IngestionJob` row tracking parsed / loaded / verified counts.

### REST surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/seed-datasets` | List the catalog |
| `GET` | `/api/lab/seed-datasets/:hash` | One dataset's detail |
| `POST` | `/api/lab/seed-datasets/:hash/run` | Run the dataset's operation on an Ultravisor |
| `POST` | `/api/lab/seed-datasets/:hash/seed-to-engine` | Seed the dataset toward an engine |

## The Synthetic Beacon

Both exercise families are driven by a **synthetic worker beacon** that lives inside the lab (not a published package), under `source/synthetic-beacon/`. It is a configurable sleep-N-milliseconds beacon: it registers with an Ultravisor, advertises a capability and a set of actions, and "processes" each work item by sleeping for a configured duration. That makes it a controllable load source for testing the queue and operation machinery without needing real workloads.

It is exposed as a lab-local beacon type (`lab-synthetic-beacon`) and is spawned two ways with the same argv shape: as a direct child process by the exercise managers, or as a container via the synthetic-beacon image. It is explicitly **not for production** - only for the harness.

## Beacon Exercises

Beacon exercises are **queue** load-test scenarios, managed by `LabBeaconExerciseManager` and defined under `beacon_exercises/<name>/exercise.json`. Each scenario declares the synthetic beacons it needs, a workload to enqueue, a cadence, and structured assertions. The manager provisions the beacons, drives the workload against a target Ultravisor's queue, taps the `queue.*` WebSocket envelopes, persists run + event rows (`BeaconExerciseRun` / `BeaconExerciseEvent`), and evaluates the assertions.

The bundled scenarios:

| Scenario | Focus |
|---|---|
| **Single capability burst** | A burst of work items against one capability. |
| **Mixed three-capability drain** | Concurrent work across three capabilities, checking drain behavior. |
| **Oversubscribed single beacon** | More work than one beacon's concurrency limit can take at once. |

Assertions can check maximum drain time, minimum observed concurrency per capability, absence of cross-capability head-of-line blocking, and a cap on failed items.

### REST surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/beacon-exercises` | List scenarios |
| `GET` | `/api/lab/beacon-exercises/:hash` | One scenario |
| `POST` | `/api/lab/beacon-exercises/:hash/run` | Start a run |
| `GET` | `/api/lab/beacon-exercise-runs` | List runs |
| `GET` | `/api/lab/beacon-exercise-runs/:id` | One run + verdicts |
| `GET` | `/api/lab/beacon-exercise-runs/:id/events` | Captured envelopes |
| `POST` | `/api/lab/beacon-exercise-runs/:id/cancel` | Cancel outstanding work |
| `GET` | `/api/lab/ultravisor-instances/:id/queue-snapshot` | Live queue snapshot |

## Operation Exercises

Operation exercises are **operation-graph** load-test scenarios, managed by `LabOperationExerciseManager`. Multi-phase operation graphs live under `operation_library/<name>/operation.json` and exercise definitions under `operation_exercises/<name>/exercise.json`. Unlike beacon exercises (which each provision their own beacons), operation exercises share a single synthetic-beacon **fleet** declared in `operation_exercises/_suite.json` - provisioned once per Ultravisor per lab session and reused across runs, torn down only when the lab exits.

The fleet covers a spread of capabilities (Parser, Transformer, Validator, Loader, DataIntegration, VideoTranscode, FileTransfer, plus direct-transport and poll-only variants) so exercises can assemble realistic ETL-style pipelines. The manager registers each exercise's operations with the target Ultravisor, kicks them at the declared cadence, polls `/Manifest/<RunHash>` to track per-run lifecycle, and evaluates assertions (`OperationExerciseRun` / `OperationExerciseEvent`).

The bundled exercises include single and parallel ETL, a loader bottleneck, mass-parallel and mixed-concurrent runs, failure isolation, a poll-mode-beacon regression, and a multi-minute "huge stress" sweep. The operation library that backs them includes linear and strict ETL, validation-only, mixed-pipeline, bulk-load fan-out, and poll-mode-only graphs.

### REST surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/operation-exercises` | List exercises |
| `GET` | `/api/lab/operation-exercises/:hash` | One exercise |
| `POST` | `/api/lab/operation-exercises/:hash/run` | Start a run |
| `GET` | `/api/lab/operation-exercise-runs` | List runs |
| `GET` | `/api/lab/operation-exercise-runs/:id` | One run + verdicts |
| `GET` | `/api/lab/operation-exercise-runs/:id/events` | Captured events |
| `POST` | `/api/lab/operation-exercise-runs/:id/cancel` | Cancel in-flight runs |

See [REST API](api.md) for the full endpoint list.
