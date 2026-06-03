# Stacks

A **stack** is a declarative description of a multi-container topology - databases, an Ultravisor, beacons, and apps, with their ports, volumes, environment, health checks, and dependencies. The lab resolves a stack's templated inputs, preflights the host, compiles the spec into a `docker-compose.yml`, and launches it with `docker compose`. The generated compose file *is* the canonical executable: you can copy it to another machine and `docker compose up` it without the lab.

Stacks are the reproducible, whole-topology counterpart to provisioning [engines](db-engines.md) and [beacons](ultravisor-beacons.md) one at a time.

## How A Stack Becomes Running Containers

Five services form the pipeline, in order:

1. **`LabStackStore`** - persists the spec. The `Stack` table in `data/lab.db` is canonical; every save is also mirrored to `data/stacks/<Hash>.json` (spec only - per-launch input values stay in SQLite so secrets don't leak into the on-disk JSON). The store also owns the read-only preset library.
2. **`LabStackResolver`** - a pure function that walks every string in the spec and substitutes variable references (below). It reports any reference that didn't resolve, but doesn't perform I/O.
3. **`LabStackPreflight`** - probes the *resolved* spec against the host and produces a `ready` / `warnings` / `blockers` report.
4. **`LabStackComposer`** - renders the resolved spec into `data/stacks/<Hash>/docker-compose.yml`. The compose project is named `stack-<Hash>`, which also becomes the network and container-name prefix, so two stacks with overlapping service names coexist.
5. **`LabStackLifecycle`** - drives `docker compose up / down / ps / logs`.

An optional sixth service, **`LabStackInitializer`**, runs a stack's init operation against its launched Ultravisor (below).

## The Spec Format

A stack spec is JSON with this shape:

```json
{
	"Hash": "my-stack",
	"Name": "My Stack",
	"Description": "...",
	"SchemaVersion": 1,
	"Inputs": { "...": { "Type": "...", "Default": "...", "Description": "..." } },
	"Components": [ { "...": "..." } ]
}
```

### Inputs

`Inputs` is a map of named values the operator fills in at launch time. Each input declares a `Type` (used by the UI and preflight), a `Default`, and a `Description`. Types seen in the bundled presets:

| Type | Meaning |
|---|---|
| `folder` | A host directory path (used for volume mounts and build contexts). |
| `port` | A host port number. |
| `secret` | A sensitive value. Preflight **blocks** the launch if a required secret resolves empty. |

Input defaults may themselves reference `${HOME}`, `${PWD}`, or `${env.X}` - for example a `MonorepoRoot` input commonly defaults to `${env.RETOLD_MONOREPO_ROOT}`.

### Components

`Components` is the list of containers. Each component has a `Hash` (its compose service name *and* its on-network hostname) and a `Type`:

- **`docker-service`** - runs a pre-built image. Declares `Image`.
- **`docker-build-from-folder`** - builds an image from a `BuildContext` directory and `Dockerfile`. This is how the lab builds Retold modules from your monorepo checkout at launch.

Common per-component fields: `Ports` (`[{ Host, Container }]`), `Volumes` (`[{ Host, Container, Mode }]`), `Environment` (a key/value map), `Command` / `Entrypoint` (array or string overrides), `HealthCheck` (`{ Command, IntervalSec, TimeoutSec, RetriesBeforeFail, StartPeriodSec }`), `DependsOn` (a list of upstream component hashes), and `RestartPolicy` (defaults to `unless-stopped`).

A component may also carry `Files: [{ Path, Content }]` - the composer materializes each to a host file and bind-mounts it read-only over the in-container path, so you can stamp a config onto a baked image without rebuilding it.

### Variable substitution

The resolver supports these reference forms inside component strings:

| Reference | Resolves to |
|---|---|
| `${input.X}` | The operator's value for input `X` (falling back to its `Default`). |
| `${component.Y.host}` | Component `Y`'s on-network hostname (= its `Hash`). |
| `${component.Y.port}` | Component `Y`'s first container port. |
| `${env.X}` | `process.env.X`. |
| `${HOME}`, `${PWD}` | `process.env.HOME`, `process.cwd()`. |

So a databeacon points at its sibling Ultravisor with `"DATABEACON_ULTRAVISOR_URL": "http://${component.ultravisor.host}:54321"`, and a volume roots under `"${input.DataRoot}/databeacon"`. References are not recursive; an unresolved reference is reported by preflight as a blocker.

### depends_on and health

When a component's `DependsOn` upstream declares a `HealthCheck`, the composer emits `condition: service_healthy` so compose waits for health, not just container start; otherwise it emits `condition: service_started`. Every service gets `lab.stack.hash` / `lab.stack.component` labels so `docker ps` shows which stack a container belongs to.

## Preflight

Before (and as part of) a launch, preflight probes the resolved spec and returns `{ Status, Items[] }` where each item is `info`, `warn`, or `block`:

- **`reference.unresolved`** - an unresolved `${...}` reference -> block.
- **`secret.empty`** - a `secret`-typed input resolved empty -> block.
- **folder probes** - for every `Volumes[*].Host`: missing -> info (created on launch); exists-empty -> info; exists-with-files -> warn (read-write) or info (read-only); resolves to a file -> block.
- **`port.in-use`** - `lsof` each `Ports[*].Host`. In use -> block, with the holding PID and command. If the holder looks like a Docker / colima / lima port mux (a container you likely own or could replace), it is downgraded to a warning.
- **`build.context-*` / `build.dockerfile-*`** - for build-from-folder components: missing context -> block; Dockerfile presence is reported.
- **`image.*`** - for `docker-service` components, `docker images -q` the tag; missing -> info (compose pulls on up).

A launch is blocked only when at least one `block` item is present.

## Launch & Teardown

**Launch** (`up`) loads the spec, resolves inputs, runs preflight (aborting with the report if there are blockers), pre-creates any missing volume host directories, generates the compose YAML, marks the stack `starting`, and runs:

```bash
docker compose -f <compose-path> -p stack-<hash> up -d --build --remove-orphans
```

`--build` is always passed so Dockerfile / source changes are picked up on every launch; the layer cache keeps incremental rebuilds fast. The first launch of a build-from-folder stack can take ten-plus minutes on a cold cache (npm install + image builds), which is why the compose timeout is generous. After compose returns, the lab polls `docker compose ps` once and rolls the per-component states up into a single phase. A per-stack launch lock rejects a second concurrent `up` for the same stack (the route turns this into a `409`); a stale lock auto-releases after 30 minutes, with a manual clear available.

**Teardown** (`down`) runs `docker compose -p stack-<hash> down --remove-orphans`. Host-mounted volumes survive - that is the whole point of binding to operator-chosen folders.

**Status** rolls `docker compose ps --format json` up into a phase: `stopped`, `starting`, `running`, `unhealthy`, `stopping`, or `error`. The UI drives the polling cadence (more often when a stack page is open). **Logs** spawns `docker compose logs` (optionally `-f`, optionally `--tail N`, optionally for one component).

### Compose CLI detection

`LabStackLifecycle` probes `docker compose version` (v2 plugin) first and falls back to `docker-compose --version` (v1 standalone) with a warning. v2 is the supported default; without either CLI, stacks cannot launch.

## Init Operations

A stack spec may carry an optional `InitOperation` that configures the stack after it is up - for example, wiring beacon connections through an Ultravisor operation graph. `LabStackInitializer` waits for the launched Ultravisor's status to respond, loads the operation graph from `LabOperationStore` by hash, substitutes the same `${input.X}` / `${component.Y.host}` references into it, re-hashes it per-stack (so multiple stacks can run "the same" init op without colliding), POSTs it to `/Operation`, executes it, polls `/Manifest/<RunHash>` to completion, and persists the result to `data/stacks/<hash>/init-state.json`. Init runs as a follow-on phase the lab tracks separately - an init failure never breaks the `up` call.

## Bundled Presets

Ten presets ship under `source/stacks/presets/`. Cloning a preset produces an editable stack with a fresh hash and `PresetSource` set; you then fill in inputs and launch.

| Preset | What it brings up |
|---|---|
| `preset-ultravisor-promiscuous` | A single Ultravisor with no auth beacon - the web UI loads straight to the dashboard with no login. Plus one of each web-UI beacon (databeacon, facto, content-system, remote, data-mapper, synth) for a no-auth smoke. |
| `preset-ultravisor-secured-internal` | Ultravisor + `ultravisor-auth-beacon` running the built-in memory auth provider; the UI requires login and exposes in-app user management. |
| `preset-ultravisor-secured-external` | Ultravisor + `ultravisor-auth-beacon` running the external-directory auth provider; simulates a deployment whose user store lives outside Ultravisor (LDAP / OIDC). |
| `preset-ultravisor-auth-gate-test` | **Self-asserting** security stack: a secured Ultravisor (`UltravisorNonPromiscuous=true` + bootstrap secret — gate hard-armed by the flag) + `ultravisor-auth-beacon`, plus a one-shot `auth-gate-tester` that proves the gate end-to-end (management read 401 without a session, WS subscribe rejected, login round-trip, then 200 + WS subscribe accepted) and exits 0/1. Minimal — no extra beacons. Read the verdict with `docker logs <project>-auth-gate-tester-1`. |
| `preset-full-beacon-smoke` | Ultravisor + auth beacon plus exactly one of every web-UI beacon - a comprehensive smoke test. |
| `preset-retold-facto` | Single-node data movement: MySQL + meadow-integration syncing from a remote Meadow API + a databeacon registered with Ultravisor. |
| `preset-retold-remote` | File-server + content-conversion: Ultravisor coordinating `retold-remote` (browse / serve files) and `orator-conversion`, backed by MariaDB. |
| `preset-retold-labs` | Ultravisor + `retold-labs`, ready for machine-learning beacons; built from the local monorepo checkout. |
| `preset-data-platform` | The full data-platform topology: Ultravisor + auth beacon + configs / lake / opdb / customer / dashboard databeacons + synth databeacon + retold-data-mapper + meadow-integration, plus the postgres + mysql backends. Beacon-to-backend connections are wired by the operator after launch. |
| `preset-data-platform-synth-demo` | The same topology as the data platform, tuned as a click-and-run demo. |

Downstream apps that embed the lab can inject their own preset directories - see [Configuration](configuration.md#embedding-the-lab).

## REST Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/stack-presets` | List presets (summaries) |
| `GET` | `/api/lab/stack-presets/:presetHash` | One full preset spec |
| `GET` | `/api/lab/stacks` | List saved stacks |
| `GET` | `/api/lab/stacks/:hash` | One stack (full spec + status) |
| `POST` | `/api/lab/stacks` | Upsert a stack by hash |
| `POST` | `/api/lab/stacks/clone-preset/:presetHash` | Materialize a preset clone |
| `DELETE` | `/api/lab/stacks/:hash` | Delete (and remove the file mirror); `?force=1` skips compose-down |
| `POST` | `/api/lab/stacks/:hash/preflight` | Run preflight against `{ InputValues }` |
| `POST` | `/api/lab/stacks/:hash/up` | Preflight + compose + `up -d` |
| `POST` | `/api/lab/stacks/:hash/down` | `compose down` |
| `GET` | `/api/lab/stacks/:hash/status` | `compose ps` rollup |
| `GET` | `/api/lab/stacks/:hash/compose-yaml` | Generated YAML preview |
| `POST` | `/api/lab/stacks/:hash/clear-launch-lock` | Clear a stuck launch lock |
| `GET` | `/api/lab/stacks/:hash/init` | Init-operation status |
| `POST` | `/api/lab/stacks/:hash/init/run` | Run the init operation |
| `GET` | `/api/lab/operations` / `/api/lab/operations/:hash` | Init-operation library |

See [REST API](api.md) for the full list.
