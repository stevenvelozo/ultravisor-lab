# Dockerized Beacons — Plan

Move supervised beacon processes (and, by symmetry, Ultravisor instances)
off the host-node lifecycle and into Docker containers. Each container
installs its package directly from the public npm registry — no bind
mounts, no monorepo paths, no shared `node_modules`.

## Goals

1. **Clean shutdown.** `docker stop` is authoritative. Killing the lab no
   longer leaves orphaned node processes listening on their ports.
2. **Published-module provenance.** A beacon runs the exact published
   version users could `npm install` themselves — no "works on my tree"
   drift.
3. **Port/filesystem isolation.** Each beacon sees only its own data
   volume; ports are mapped explicitly.
4. **Single lab host process.** The lab itself stays on the host (Electron
   roadmap, direct filesystem access to `seed_datasets/`, simplest dev
   loop). Only the things the lab *manages* move to containers.

## Non-goals

- Dockerizing the lab itself.
- Supporting beacons from a working tree / un-published code. During active
  beacon-module development the author publishes a pre-release tag
  (`npm publish --tag next`) and the lab pins to that tag.
- Kubernetes / compose files. The lab drives the docker CLI the same way
  `LabDockerManager` already drives DB engines.

---

## Architecture

### Runtime topology

```
┌────────────────────────────────────────────────────────┐
│ host                                                   │
│                                                        │
│  ultravisor-lab (node, port 44443)                     │
│     │                                                  │
│     │ docker CLI                                       │
│     ▼                                                  │
│  ┌──────────────── docker network: ultravisor-lab ──┐  │
│  │                                                  │  │
│  │  ┌─ mysql-<id>          (DB engine, already      │  │
│  │  │     ports: 33306 → 3306         containerized)│  │
│  │  │                                               │  │
│  │  ├─ ultravisor-<id>     (new)                    │  │
│  │  │     ports: 54321 → 54321                      │  │
│  │  │                                               │  │
│  │  ├─ beacon-<id>         (new)                    │  │
│  │  │     ports: 8500  →  8500                      │  │
│  │  │     volumes: beacon-<id>-data → /app/data     │  │
│  │  │                                               │  │
│  │  └─ beacon-<id>         (new)                    │  │
│  │        ports: 54400 →  54400                     │  │
│  │                                                  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

Containers resolve each other by container name via docker's embedded
DNS. A beacon pointed at `http://ultravisor-5:54321` works from any
container on the `ultravisor-lab` network.

### Image strategy

One generic image per beacon "mode", parameterized at runtime. Each image
is a thin wrapper: FROM node, `npm install <package>@<version>`, run.

| Image | Source package | Mode |
|---|---|---|
| `retold-databeacon` | `retold-databeacon` | standalone bin |
| `retold-facto` | `retold-facto` | standalone bin |
| `retold-content-system` | `retold-content-system` | standalone bin |
| `retold-remote` | `retold-remote` | standalone bin |
| `retold-beacon-host` | `ultravisor-beacon` + one or more `retold-beacon-provider-*` | capability-provider host |

The `retold-beacon-host` image hosts any number of CapabilityProviders —
installs them via `npm install <provider-package>@<version>` at image
build time. The lab picks an image tag by beacon type; the `retoldBeacon`
stanza in each provider's published `package.json` tells the lab which
image to pull.

### Images built by whom?

**The lab ships no Dockerfiles by default.** It pulls from Docker Hub
(`stevenvelozo/retold-databeacon:0.0.7`, etc.). CI in each module's repo
builds and pushes on `npm publish`.

For local development against an un-published change, the lab exposes a
`docker.imageOverride` per beacon type in the UI — "use
`retold-databeacon:local` instead of the registry tag". The developer
runs `docker build -t retold-databeacon:local .` once, and the lab picks
it up.

---

## State changes

### Beacon table

| Column | Was | Is |
|---|---|---|
| `PID` | host process id | **remove** |
| `ContainerID` | — | docker container id |
| `ImageName` | — | `retold-databeacon` |
| `ImageVersion` | — | `0.0.7` (tag pulled) |
| `ContainerName` | — | `beacon-<id>` (stable, used for DNS) |
| `NetworkName` | — | `ultravisor-lab` (constant today, reserved for future multi-network) |

`Status` semantics unchanged (`running` / `stopped` / `error`), sourced
from `docker inspect` now rather than `kill(pid, 0)`.

### UltravisorInstance table

Same treatment. `PID` → `ContainerID`, image is `ultravisor` published
package, listens on its configured port.

### DBEngine table

Unchanged — already container-backed.

---

## Service changes

### New: `LabBeaconContainerManager` (replaces the beacon half of `LabProcessSupervisor`)

Mirrors the surface of `LabDockerManager` already used for DB engines.
Methods:

- `create(pBeaconRow, fCallback)` — `docker create` with the right image,
  ports, volume, env, network. Stores `ContainerID` on the Beacon row.
- `start(pContainerID, fCallback)` — `docker start`.
- `stop(pContainerID, fCallback)` — `docker stop --time=10`.
- `remove(pContainerID, fCallback)` — `docker rm`. Called when the user
  deletes the beacon.
- `inspect(pContainerID, fCallback)` — `docker inspect` → status,
  started-at, exit code. Used by the reconciler.
- `logs(pContainerID, pTailN, fCallback)` — `docker logs --tail=N`.
  Replaces reading `data/logs/Beacon-N.log`.

### Changed: `Service-BeaconManager`

`startBeacon` / `stopBeacon` / `removeBeacon` delegate to
`LabBeaconContainerManager` instead of `LabProcessSupervisor`.

`createBeacon` (new-row flow) resolves the image name + tag from the
`BeaconTypeRegistry` descriptor:

```js
let tmpImage = `${tmpDescriptor.DockerImage}:${tmpDescriptor.DockerImageTag || tmpDescriptor.PackageVersion}`;
```

All paths currently passed as `--config /Users/.../config.json` become
mounted paths inside the container (see **Volumes** below).

### Changed: `Service-ReconcileLoop`

`SUPERVISED_ENTITIES` stops being the one-size-fits-all list. Split into:

```js
const PROCESS_SUPERVISED   = [ ]; // empty once Ultravisor also moves
const CONTAINER_SUPERVISED = [
    { Table: 'DBEngine',           IDColumn: 'IDDBEngine',           EntityType: 'DBEngine' },
    { Table: 'UltravisorInstance', IDColumn: 'IDUltravisorInstance', EntityType: 'UltravisorInstance' },
    { Table: 'Beacon',             IDColumn: 'IDBeacon',             EntityType: 'Beacon' }
];
```

The container path is what's already proven for DB engines. Drift
reporting becomes uniform — all three entity types report via the same
`docker inspect` code path.

### Changed: `BeaconTypeRegistry`

The `retoldBeacon` stanza in each published package grows a docker block:

```json
{
    "retoldBeacon": {
        "displayName": "Retold-DataBeacon",
        "mode": "standalone-service",
        "defaultPort": 8500,
        "docker": {
            "image":          "stevenvelozo/retold-databeacon",
            "tag":            "0.0.7",
            "entrypoint":     ["node", "bin/retold-databeacon.js", "serve"],
            "dataVolumePath": "/app/data",
            "configMountPath": "/app/data/config.json",
            "exposedPort":    8500
        }
    }
}
```

The lab-local `LOCAL_REGISTRY_ENTRIES` in
`Service-BeaconTypeRegistry.js` goes away — the lab-local
`Lab-MeadowIntegration-BeaconProvider.js` becomes a real published
package (`retold-beacon-provider-meadow-integration`) with its own
`retoldBeacon` stanza pointing at the generic `retold-beacon-host`
image.

### Changed: `lab-beacon-host.js`

Becomes a `retold-beacon-host` npm package with a `bin`. Its CLI stays
the same, but `--provider label:path` is replaced with `--provider
<npm-package-name>` — the host `require()`s the installed package. No
more host-filesystem paths in argv.

The lab no longer ships this binary. Image build:

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN npm install --omit=dev retold-beacon-host ultravisor-beacon
ENTRYPOINT ["node", "/app/node_modules/.bin/retold-beacon-host"]
```

Per-type images add their providers at build time:

```dockerfile
FROM stevenvelozo/retold-beacon-host:1.0.0
RUN npm install --omit=dev retold-beacon-provider-meadow-integration@1.0.0
CMD ["--provider", "retold-beacon-provider-meadow-integration"]
```

---

## Volumes, networking, ports

### Network

One docker network `ultravisor-lab`, created at first use
(`docker network create ultravisor-lab` — idempotent, guarded by
`LabDockerManager.ensureNetwork`).

Container DNS names are stable: `beacon-<id>`, `ultravisor-<id>`,
`mysql-<id>`, etc. A beacon connecting to a DB engine uses the engine's
container name, not `127.0.0.1`.

### Host port mapping

Still bind every service to a host port for the browser UI / external
tools:

```
docker run -p 8500:8500 ...
```

`LabPortAllocator` already picks unused host ports; the logic carries
over unchanged.

### Volumes

Named volumes per entity, lifecycle-tied to the row:

| Volume name | Mounted at | Contains |
|---|---|---|
| `lab-beacon-<id>` | `/app/data` | beacon state (config.json, sqlite, logs) |
| `lab-ultravisor-<id>` | `/app/data` | ultravisor workspace (operations, run logs) |
| `lab-mysql-<id>` | `/var/lib/mysql` | DB engine data (already this way) |

Lab code writes config once, into `/app/data/config.json` inside the
container, via `docker cp` at create time (or an init-container step).
No bind-mount into the host filesystem — the lab reaches into the
container when it needs to update config.

### Seed dataset files

`retold-beacon-host` + meadow-integration provider need read access to
the seed JSON files. Approach: the lab doesn't ship the files into the
container. Instead:

1. Lab stages a temporary dataset bundle on disk.
2. `docker cp <bundle> <container>:/app/seed_input/`.
3. Work item fires with absolute in-container path `/app/seed_input/...`.
4. On completion the lab removes the staged bundle from the container.

No host path leaks into beacon code; the beacon sees only paths it was
told about.

---

## Migration (one-shot)

Existing rows in the state store reference PIDs, absolute provider
paths, per-module config files on the host. Rather than migrate
field-by-field:

1. Mark a schema version bump in `LabStateStore` (`SchemaVersion` row).
2. On first boot after upgrade, if the old version is seen, **wipe
   Beacon + UltravisorInstance tables** and recreate fresh container
   rows from user input.

User already signalled this is fine ("no backwards compat, start
fresh"). Ingestion jobs + seed definitions survive.

---

## Work plan

Ordered for smallest-possible reviewable chunks. Each chunk leaves the
lab in a working state.

### Phase 1 — infrastructure (no UI change visible)
- [ ] Publish `retold-beacon-host` package (today's `bin/lab-beacon-host.js` plus a tiny CLI adapter for the new `--provider <npm-name>` arg)
- [ ] Publish `retold-beacon-provider-meadow-integration` (today's `Lab-MeadowIntegration-BeaconProvider.js`, lifted verbatim)
- [ ] Dockerfiles + publish images: `retold-beacon-host`, `retold-databeacon` (databeacon adds one)
- [ ] Add `docker` block to each module's `retoldBeacon` stanza in their published `package.json`
- [ ] Smoke test each image standalone: `docker run --rm retold-databeacon:latest serve --port 8500`

### Phase 2 — container manager (lab-side, beacons only)
- [ ] Add `LabBeaconContainerManager` mirroring `LabDockerManager` patterns; reuse the latter's probe / network / run helpers
- [ ] Extend `LabDockerManager` with `ensureNetwork`, `createContainer`, `attachToNetwork` helpers shared by engines and beacons
- [ ] Swap `Service-BeaconManager` to call `LabBeaconContainerManager`
- [ ] Update `Beacon` table schema; wipe-on-upgrade migration
- [ ] Update `Service-ReconcileLoop` to move `Beacon` into the container-supervised bucket

### Phase 3 — Ultravisor symmetric treatment
- [ ] Publish `ultravisor` image (wrapper of the already-published `ultravisor` npm module)
- [ ] Add `UltravisorInstance.ContainerID` / remove `PID`
- [ ] New `LabUltravisorContainerManager` or fold into the beacon one
- [ ] Wipe-and-recreate migration

### Phase 4 — UI + dev ergonomics
- [ ] "Image" column + tag picker in the per-beacon-type create form (read default from `retoldBeacon.docker`, allow override)
- [ ] `imageOverride` setting per beacon type: use `retold-databeacon:local` when set
- [ ] `docker logs` wired into the Beacon detail page (replaces reading `data/logs/Beacon-N.log`)
- [ ] Auto-pull on start: `docker pull <image>:<tag>` before `docker run` if image absent or `latest`

### Phase 5 — cleanup
- [ ] Delete `LabProcessSupervisor` once Ultravisor + Beacons are fully container-backed
- [ ] Delete sibling-checkout / local provider-path plumbing in `BeaconTypeRegistry`
- [ ] Delete `bin/lab-beacon-host.js` and `source/beacon_providers/` from the lab repo

### Effort estimate

| Phase | Days |
|---|---|
| 1. Packages + images published | 2 |
| 2. Beacon container manager + lab integration | 2.5 |
| 3. Ultravisor symmetric | 1 |
| 4. UI + dev ergonomics | 1.5 |
| 5. Cleanup | 0.5 |
| **Total** | **~7.5** |

Assumes each module's maintainer (you) can publish npm + docker tags on
demand. The lab-side work is mechanical; the publishing pipeline is the
critical path for phase 1.

---

## Dev loop story

Today: edit `meadow-integration/source/...`, save, next beacon spawn
sees the change because of sibling-checkout resolution.

After: edit `meadow-integration/source/...`, save, then:

1. `npm publish --tag next` from `meadow-integration/` (or a local
   `npm pack` + `npm install file:...`).
2. `docker build -t retold-beacon-provider-meadow-integration:local .`
   from that module.
3. Flip the per-beacon-type image override to `:local` in the lab UI.
4. Restart the beacon.

Three steps vs zero. The offset: a `retold-publish-local.sh` convenience
script that does all three in one shot, plus a lab UI checkbox "always
prefer :local tag when available" so the image-override flip is
permanent during an iteration session.

Is this worse for the inner dev loop? Yes, by ~5–10 seconds per
iteration. It's the price of published provenance. Acceptable once
beacon modules are past early-iteration — not acceptable while a new
provider is being authored, which is why the `:local` override path
exists.

---

## Open questions

1. **Image registry.** Docker Hub namespace `stevenvelozo/*`? Private
   registry? Github Container Registry? Not a blocker for phase 1
   (local builds work without publish), but picking before phase 2
   lands.
2. **Per-user host port ranges.** Today `LabPortAllocator` picks from
   `50000-60000`. Fine on one-dev machines; needs a per-install range
   story if two labs run on one host (rare).
3. **Beacon config secrets** (DB passwords etc.). Staging via
   `docker cp` keeps them off the host filesystem but they still land
   in the container volume. Acceptable for a dev lab; worth noting for
   any future multi-user deployment.
4. **Native modules**. `better-sqlite3` and friends are built per-arch
   inside the image, so `npm install` inside an alpine image Just
   Works. But base image choice (alpine musl vs debian-slim) matters
   for any module that ships precompiled binaries — keep an eye on
   this during phase 1 smoke tests.

---

## Summary

Every moving part the lab manages becomes a container pulled from a
public npm-published module, wired to a shared docker network, state
reflected in the existing state-store fields (`ContainerID` replacing
`PID`). The lab itself stays on the host and drives docker the same way
it already does for DB engines. Dev loop gets one extra publish/build
step; in exchange, orphaned-child cleanup, port collisions, and
"works on my tree" drift all go away.

About a week of focused work, split into five reviewable phases, each
of which leaves the lab green.
