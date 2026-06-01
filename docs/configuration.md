# Configuration

Ultravisor Lab is configured mostly through command-line flags and a couple of environment variables. There is no config file to edit for the common cases.

## Launch Flags

`lab.js` accepts:

| Flag | Default | Effect |
|---|---|---|
| `--port <N>` | `44443` | Bind the web server to port N. Validated to `1-65535`. |
| `--host <ADDR>` | `127.0.0.1` | Bind to interface ADDR. Use `0.0.0.0` to expose on the network. |
| `--no-open` | - | Do not auto-open the browser on start. |
| `--open` | (default) | Auto-open the browser. |
| `--help`, `-h` | - | Print usage and exit. |

`--port=N` and `--host=ADDR` (with `=`) are also accepted. `--web` is accepted and ignored - the web server is the only mode today; a TUI mode is noted as a future possibility, at which point the lab would dispatch on `--web` the way `retold-manager` does.

```bash
node lab.js --port 5555 --host 0.0.0.0 --no-open
```

The default `127.0.0.1` bind keeps the lab off the local network unless you opt in.

## The Data Directory

Lab state lives in a `data/` directory next to `lab.js`. The CLI entry passes this path to `setupLabServer()`. It holds:

| Path | Contents |
|---|---|
| `data/lab.db` | The SQLite state store (all entity tables + the event log). |
| `data/beacons/<id>/` | Per-beacon rendered `config.json` and process logs. |
| `data/ultravisors/<id>/` | Per-instance `.ultravisor.json`, `operations/` library, file store, run staging. |
| `data/stacks/<Hash>.json` | The file mirror of each stack spec. |
| `data/stacks/<Hash>/docker-compose.yml` | The generated compose file for a stack. |
| `data/pids/` | PID files for host-process beacons (so a fresh lab can adopt them on boot). |
| `data/crash-<timestamp>.log` | Stack trace written on an uncaught exception before exit. |

The SQLite schema is created and migrated automatically on boot from `model/MeadowModel-Lab.json` - there is no manual migration step.

## Monorepo Root

Stacks and source-mode beacons build Docker images from the Retold modules in your monorepo checkout. The lab needs to know where that checkout is, exposed as the `RETOLD_MONOREPO_ROOT` environment variable (preset defaults reference it as `${env.RETOLD_MONOREPO_ROOT}`).

`lab.js` resolves it as follows, with an explicit env var always winning:

1. If `RETOLD_MONOREPO_ROOT` is already set, use it.
2. Otherwise, if `lab.js` is running from inside a Retold checkout (a `Retold-Modules-Manifest.json` sits four levels up from the module), use that root.
3. Otherwise, fall back to `${HOME}/Code/retold`.

To point the lab at a checkout elsewhere:

```bash
RETOLD_MONOREPO_ROOT=/path/to/retold node lab.js
```

Independently, the [beacon type registry](ultravisor-beacons.md#beacon-types) resolves each beacon module from a sibling checkout under `retold/modules/*/<module>/` before falling back to the lab's installed `node_modules`, so the lab picks up local edits to sibling repos without an `npm link`.

## Building The Browser Bundle

| Command | What it does |
|---|---|
| `npm start` | `node lab.js` - start the web server. |
| `npm run brand` | Generate the brand block + favicons via `pict-section-theme`. |
| `npm run build-bundle` | Run `npm run brand`, then `npx quack build && npx quack copy` to produce `web/dist/`. |

When `web/dist/` exists the server serves it; otherwise it serves the `web/html` + `web/css` source tree and logs a warning. Either way the UI works.

## Embedding The Lab

`setupLabServer()` is exported from the package so a downstream app (for example, an app that extends the lab) can run it in-process with customizations:

```javascript
const libSetupLabServer = require('ultravisor-lab').setupLabServer;

libSetupLabServer(
	{
		Port:    44443,
		Host:    '127.0.0.1',
		DataDir: '/path/to/data',
		Branding:
		{
			Product:        'My-Platform-Lab',
			ProductVersion: '1.2.3',
			DisplayName:    'My Platform Lab',
			LogoURL:        '/assets/logo.svg'
		},
		AdditionalPresetDirs:    [ '/path/to/my/presets' ],
		AdditionalOperationDirs: [ '/path/to/my/operations' ]
	},
	(pError, pServerInfo) =>
	{
		// pServerInfo = { Fable, Orator, Core, Port, Host, DistPath }
	});
```

Options:

| Option | Effect |
|---|---|
| `Port` / `Host` | Bind target (defaults `44443` / `127.0.0.1`). |
| `DataDir` | The data directory (the SQLite store and per-entity dirs live here). |
| `DistPath` | Override the served bundle directory. |
| `Branding` | `Product` / `ProductVersion` override the Fable identity and the title bar; `DisplayName` / `LogoURL` feed `GET /api/lab/branding`. When omitted, the UI falls back to its built-in "Ultravisor Lab" defaults. |
| `AdditionalPresetDirs` | Extra directories of `*.json` [stack presets](stacks.md#bundled-presets) scanned after the bundled set, so a downstream app's presets appear alongside the lab's. |
| `AdditionalOperationDirs` | Extra directories of init-operation graphs looked up by `LabStackInitializer`. |

> The CLI side effects in `lab.js` are gated on `require.main === module`, so requiring the package to call `setupLabServer()` yourself does not also spawn the default CLI lab.
