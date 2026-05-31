# Web UI

The lab's browser interface is a [Pict](https://fable-retold.github.io/pict/) application served from the same Node process as the REST API, at `http://127.0.0.1:44443/`. The HTML page loads the Pict library and the lab bundle, instantiates the application, and initializes it. If the bundle is missing the page shows a clear message telling you to run `npm run build-bundle`.

## Layout

The application chrome is built on `pict-section-modal`'s shell. One layout view owns the shell; every other view renders into a panel:

```
┌──────────────────────────────────────────────────────────────┐
│  Top bar (fixed)  — brand · active-view label · Docker badge,  │
│                     Refresh button, settings gear              │
├────────────┬───────────────────────────────────────────────────┤
│  Sidebar   │  Content area                                     │
│  (left,    │  (the active feature view renders here)           │
│  resizable)│                                                   │
└────────────┴───────────────────────────────────────────────────┘
```

Plus a **hidden settings panel** that overlays from the right when you click the gear in the top bar. Below 960px the sidebar collapses into a responsive drawer.

### Top bar

The top bar's user slot hosts:

- a **Docker daemon status badge**, sourced from the periodic `GET /api/lab/status` poll;
- a **Refresh** button that re-runs the reconcile and refreshes app data;
- a **gear** that toggles the settings panel.

### Settings panel

The settings panel hosts **Appearance** controls from `pict-section-theme` — a theme picker, a light/dark mode toggle, and a UI scale selector. Theme state is owned by `pict-section-theme` in its own storage scope.

## Navigation

The sidebar groups the views; each link is a `#/view/...` hash that the router resolves into `setActiveView()`:

**Top level**

- **Overview** — the dashboard: Docker status, entity counts, and the latest reconcile.
- **Stacks** — list, create-from-preset, edit, preflight, launch, and tear down [stacks](stacks.md).

**Services**

- **Ultravisor** — create and supervise [Ultravisor instances](ultravisor-beacons.md#ultravisor-instances); manage operations, runs, and persistence-beacon assignment.
- **Ultravisor Beacons** — create and supervise [beacons](ultravisor-beacons.md#beacons); rebuild images and switch build sources.
- **DB Engines** — create and supervise [database engines](db-engines.md) and the databases inside them.

**Experiments**

- **Seed Data** — browse and run packaged [seed datasets](seed-data-and-exercises.md#seed-datasets).
- **Beacon Exercises** — run [queue load-test fixtures](seed-data-and-exercises.md#beacon-exercises) and inspect their runs.
- **Operation Exercises** — run [operation-graph load-test fixtures](seed-data-and-exercises.md#operation-exercises).

**Activity**

- **Events** — the infrastructure event timeline, fed by the `InfrastructureEvent` table.

## Common Interactions

Every list view fronts the corresponding [REST endpoints](api.md). Create forms suggest a free host port from the [port allocator](architecture.md#the-service-layer) and pre-fill type-specific fields. Long-running operations (image builds, health polling, compose launches) surface progress into both the entity's status detail and the Events timeline, so you can watch a multi-minute first build proceed. Engine and beacon cards expose a logs modal backed by `docker logs`.

## Branding

The UI's product name and logo come from `GET /api/lab/branding`, which returns whatever branding was passed to `setupLabServer()` (see [Configuration](configuration.md#embedding-the-lab)). With no branding supplied, the bundle falls back to its built-in "Ultravisor Lab" name and default icons, so the vanilla app renders unchanged. Favicons and the brand block are generated at build time by the `npm run brand` step.
