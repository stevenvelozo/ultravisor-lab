# DB Engines

The lab provisions database engines as Docker containers, one per engine, and lets you create and drop databases inside them. Engines are managed by `LabDBEngineManager`, which delegates the raw `docker` calls to `LabDockerManager` and the engine-specific commands (health check, create / drop database, connection string) to per-engine adapters in `source/services/engines/`.

## Supported Engines

Each engine type is an adapter registered in `Engine-Registry.js`. The defaults below come straight from those adapters.

| Engine | Type key | Default image | Internal port | Suggested host port | Root user | Databases |
|---|---|---|---|---|---|---|
| MySQL | `mysql` | `mysql:8.4` | 3306 | 33306 | `root` | multiple |
| PostgreSQL | `postgres` | `postgres:16` | 5432 | 35432 | `postgres` | multiple |
| Microsoft SQL Server | `mssql` | `mcr.microsoft.com/mssql/server:2022-latest` | 1433 | 31433 | `sa` | multiple |
| MongoDB | `mongodb` | `mongo:7` | 27017 | 37017 | `admin` | multiple |
| Apache Solr | `solr` | `solr:9` | 8983 | 38983 | `solr` | multiple (cores) |
| DGraph | `dgraph` | `dgraph/standalone:v24.0.5` | 8080 | 38080 | `groot` | single |

Notes:

- **DGraph** exposes a single graph rather than multiple databases, so its create-database form is hidden in the UI (`SupportsMultipleDatabases: false`). Solr labels its databases "cores" rather than "databases" (`DatabaseNoun: 'core'`).
- **SQLite and RocksDB are intentionally absent** — they are embedded libraries with no server process to provision. There is nothing for a DB-engine container to manage.
- The image tag is overridable per engine at create time; the suggested host port is just a starting point for the [port allocator](architecture.md#the-service-layer).

## Engine Lifecycle

### Create

When you add an engine, the manager:

1. Validates the request (engine type, non-empty name, port in `1–65535`) and validates or defaults the root password via the adapter.
2. Inserts a `DBEngine` row in `provisioning` state so the UI shows a pending card immediately, and records an `engine-create-started` event.
3. Ensures the shared `ultravisor-lab` docker network exists.
4. Pulls the image (a no-op if already present).
5. Runs the container on that network with a stable hostname (`lab-<type>-<name>`, sanitized), the chosen host→internal port mapping, and the adapter's environment and extra run args.
6. Records the container id, then **polls for health in the background** by running the adapter's health-check command via `docker exec` (up to 60 attempts, every 2 seconds — about a two-minute budget). The API responds right away in `provisioning`; the card flips to `running` when the health check passes, or `failed` on timeout or any earlier error.

### Start / Stop / Remove

- **Start** runs `docker start` on the recorded container and re-enters the health poll.
- **Stop** runs `docker stop` and marks the row `stopped`.
- **Remove** runs `docker rm -f` (when a container exists), cascade-deletes the engine's `Database` rows from lab state, and removes the engine row. If the container is already gone the removal proceeds anyway and logs a warning.

### Status values

Engine rows move through `provisioning`, `starting`, `running`, `stopping`, `stopped`, and `failed`. A `StatusDetail` string carries the current step ("Pulling image...", "Waiting for engine to accept connections...", an error message, etc.).

## Databases Inside An Engine

With an engine `running`, you can create a database from its card. The manager validates the name (must start with a letter or underscore; letters, digits, and underscores only), runs the adapter's create-database command via `docker exec`, and inserts a `Database` row on success. Dropping a database runs the adapter's drop command when the engine is up, and unlinks the row from lab state; if the engine is stopped, the row is removed from state only (the real database stays in the container until the engine is back up).

## Connection Info

Each engine card exposes connection info computed by the adapter — host (`127.0.0.1`), the host port, the root username and password, and a ready-to-paste connection string. For example, MySQL returns `mysql://root:<password>@127.0.0.1:<port>` and PostgreSQL returns `postgres://postgres:<password>@127.0.0.1:<port>/postgres`. Other containers on the `ultravisor-lab` network reach the engine by its container name instead of `127.0.0.1`.

## Container Logs

The lab can tail an engine container's logs (`docker logs --tail N`, default 500, capped at 5000) and surface them in the same logs modal used for beacons.

## REST Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/lab/db-engine-types` | Engine registry metadata (for the create form) |
| `GET` | `/api/lab/db-engine-types/:engineType/next-port` | Next free host port suggestion |
| `GET` | `/api/lab/db-engines` | List engines |
| `GET` | `/api/lab/db-engines/:id` | One engine with its databases + connection info |
| `POST` | `/api/lab/db-engines` | Create (responds `202`, polls health in the background) |
| `POST` | `/api/lab/db-engines/:id/start` | Start |
| `POST` | `/api/lab/db-engines/:id/stop` | Stop |
| `DELETE` | `/api/lab/db-engines/:id` | Remove (cascades to its databases) |
| `GET` | `/api/lab/db-engines/:id/connection-info` | Connection info only |
| `GET` | `/api/lab/db-engines/:id/logs` | Tail container logs |
| `POST` | `/api/lab/db-engines/:id/databases` | Create a database inside the engine |
| `DELETE` | `/api/lab/db-engines/:id/databases/:dbid` | Drop a database |

See the [REST API](api.md) reference for the full endpoint list, and [Stacks](stacks.md) for declaring database containers as part of a multi-service topology instead of one at a time.
