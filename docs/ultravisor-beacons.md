# Ultravisor & Beacons

The lab supervises two kinds of Retold service as individual entities: **Ultravisor instances** (the workflow / operation coordinator) and **beacons** (the things that connect to an Ultravisor and provide capabilities or data). Both are built on demand into Docker images and run as containers on the shared `ultravisor-lab` network.

For provisioning a whole topology of these at once, see [Stacks](stacks.md). This page covers the one-at-a-time entity managers.

## Ultravisor Instances

An Ultravisor instance is one container running the published [`ultravisor`](https://stevenvelozo.github.io/ultravisor/) package's CLI. The lab does not bake a startup script into the image — it renders a config file and the container runs `ultravisor start -c /app/data/.ultravisor.json`. Managed by `LabUltravisorManager`.

### Create

When you add an instance, the manager:

1. Validates the request (non-empty name, port `1–65535`) and inserts an `UltravisorInstance` row in `provisioning`.
2. Creates the instance's host directory `data/ultravisors/<id>/` and its `operations/` library.
3. Renders `.ultravisor.json` into that directory. All paths in the config are the *inside-container* view (`/app/data/...`) because the lab bind-mounts the host directory to `/app/data` at run time. The config sets the API port (`54321`), file-store and staging paths, the operation-library path, and Ultravisor's beacon-mesh timeouts.
4. Provisions the bundled [seed-dataset](seed-data-and-exercises.md) operations into the library.
5. Builds the `ultravisor` image on demand from `docker/ultravisor.Dockerfile` (the first build can take a few minutes; subsequent ones hit the layer cache).
6. Runs the container on the shared network with a stable hostname (`lab-ultravisor-<id>`), mapping the chosen host port to the internal `54321`, and bind-mounting the instance directory to `/app/data`.
7. Polls the API for readiness (up to two minutes for a cold container boot), flips the row to `running`, and POSTs each operation-library file to the Ultravisor's `/Operation` endpoint so the operations are live without a restart.

### Secured mode

Creating an instance with `Secure: true` flips the Ultravisor into non-promiscuous mode and mints a per-instance bootstrap auth secret (32 random bytes, hex-encoded). The secret is persisted on the row but **never returned through the public API** — read accessors scrub it before sending to the browser. It is used internally by the auth-beacon spawn flow and the first-user provisioning flow. Once an admin user is provisioned (via `POST /api/lab/ultravisor-instances/:id/bootstrap-admin`), the lab no longer needs the secret.

### Start / Stop / Remove

- **Start** re-renders the config (so stanza changes flow into existing instances), then `docker start`s the recorded container. If the stored container is gone (manual `docker rm`, lab DB moved between machines), the manager rebuilds the image and runs a fresh container.
- **Stop** runs `docker stop` and marks the row `stopped`.
- **Remove** cascades first — beacons registered with this Ultravisor are removed before the Ultravisor itself — then `docker rm -f`s the container and deletes the instance directory.

### Operations, runs, and persistence

`LabUltravisorManager` also exposes helpers the UI and other services use against a running instance: register an operation (`POST /Operation`), trigger an operation asynchronously, fetch a run manifest, list operations, and manage **persistence-beacon assignment** — routing an Ultravisor's queue / manifest persistence to a chosen databeacon connection and reflecting the live bootstrap state back as a status pill.

## Beacons

A beacon is any service that connects up to an Ultravisor. The lab discovers beacon *types* from the `retoldBeacon` stanza published in each Retold module's `package.json`, and provisions instances of those types. Managed by `LabBeaconManager`, with container builds handled by `LabBeaconContainerManager` and type discovery by `LabBeaconTypeRegistry`.

### Beacon types

The registry scans a fixed set of modules for a `retoldBeacon` stanza. A module contributes a beacon type only if it declares one:

| Module | Owner |
|---|---|
| [`retold-databeacon`](https://fable-retold.github.io/retold-databeacon/) | fable-retold |
| [`meadow-integration`](https://fable-retold.github.io/meadow/) | fable-retold |
| `orator-conversion` | fable-retold |
| [`retold-facto`](https://fable-retold.github.io/retold-facto/) | stevenvelozo |
| `retold-content-system` | fable-retold |
| [`retold-remote`](https://fable-retold.github.io/retold-remote/) | stevenvelozo |
| `ultravisor-auth-beacon` | stevenvelozo |

A module is resolved from your monorepo checkout first (so the lab picks up local edits) and falls back to its installed `node_modules` copy. One **lab-local** type — the synthetic worker beacon used by the queue exercises — is hand-defined inside the lab and merged in; see [Seed Data & Exercises](seed-data-and-exercises.md).

Each stanza declares a `mode`:

- **`standalone-service`** — the module ships a bin the lab supervises (e.g. `retold-databeacon serve --config <path>`).
- **`capability-provider`** — the lab runs a generic `retold-beacon-host` container that loads a capability-provider class the module exports.

The stanza also carries the display name, category, default port, health-check path, an optional `pict-section-form` config schema for the per-type create form, an optional config template, and (when present) a `docker` block that tells the lab how to image the beacon.

### Container vs. host-process runtime

A beacon's `Runtime` is frozen on its row at create time:

- If the type's stanza carries a **`docker` block**, the beacon runs as a **container** via `LabBeaconContainerManager` on the shared network.
- Otherwise it falls back to the **host-process** path via `LabProcessSupervisor`. Capability-provider beacons are container-only — there is no host-process fallback for them.

On boot the lab migrates any legacy rows whose type now has a docker block to container runtime.

### Create

The manager validates the request, inserts a `Beacon` row in `provisioning`, creates `data/beacons/<id>/`, and renders a `config.json` from the type's config template (substituting lab-computed tokens — port, beacon name, data dir, Ultravisor URL — then overlaying the user's form values). For container beacons that config is bind-mounted into the container; the manager builds the image, runs the container wired to the Ultravisor, and polls the health path until ready. For host-process beacons it builds a spawn command from the stanza's arg template and supervises the child.

### Image tags and build sources

Container beacons are tagged under the `ultravisor-lab/` namespace:

- **npm build** — `ultravisor-lab/<image>:<version>`, built from the module's published version.
- **source build** — `ultravisor-lab/<image>:source-b<IDBeacon>`, built from a fresh `npm pack` of your sibling monorepo checkout so the image reflects in-flight edits. The per-beacon tag suffix means toggling one beacon's source build never disturbs siblings.

Two controls let you iterate without recreating a beacon:

- **Rebuild image** — stops and removes the container, best-effort `docker rmi`s the cached tag, and rebuilds fresh. Useful after bumping a module's published version.
- **Switch build source** — flips a beacon between npm-built and source-built images (source builds require a docker block plus a sibling checkout).

### Start / Stop / Remove

Start, stop, and remove route through the container manager or the process supervisor depending on the row's `Runtime`. Removing a beacon stops/removes its container or process and deletes its data directory. When an Ultravisor is removed, its beacons are cascaded first.

### Container logs

For container beacons the lab tails `docker logs`; the same logs modal serves engines and beacons.

## REST Surface

### Ultravisor

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/ultravisor-instances/next-port` | Next free host port |
| `GET` | `/api/lab/ultravisor-instances/:id` | One instance (secret scrubbed) |
| `POST` | `/api/lab/ultravisor-instances` | Create |
| `POST` | `/api/lab/ultravisor-instances/:id/start` / `/stop` | Start / stop |
| `DELETE` | `/api/lab/ultravisor-instances/:id` | Remove (cascades beacons) |
| `POST` | `/api/lab/ultravisor-instances/:id/bootstrap-admin` | Provision the first admin user (secured mode) |
| `GET` | `/api/lab/ultravisor-instances/:id/operations` | List operations |
| `GET` | `/api/lab/ultravisor-instances/:id/runs/:run` | Run manifest |
| `GET` | `/api/lab/ultravisor-instances/:id/logs` | Tail container logs |
| `POST` | `/api/lab/ultravisor-instances/:id/persistence-beacon` | Assign / clear persistence beacon |
| `GET` | `/api/lab/ultravisor-instances/:id/persistence-status` | Persistence status pill |

### Beacons

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/beacon-types` | Discovered beacon types (for the create form) |
| `GET` | `/api/lab/beacons/next-port` | Next free host port |
| `GET` | `/api/lab/beacons/:id` | One beacon |
| `GET` | `/api/lab/beacons/:id/connections` | Live connections inside a running databeacon |
| `POST` | `/api/lab/beacons` | Create |
| `POST` | `/api/lab/beacons/:id/start` / `/stop` | Start / stop |
| `POST` | `/api/lab/beacons/:id/rebuild` | Rebuild the container image |
| `POST` | `/api/lab/beacons/:id/build-source` | Switch npm ↔ source build |
| `DELETE` | `/api/lab/beacons/:id` | Remove |
| `GET` | `/api/lab/beacons/:id/logs` | Tail container logs |

See [REST API](api.md) for the complete list.
