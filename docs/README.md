# Ultravisor Lab

> Provision dockerized engines, beacons, and Ultravisor instances from one web UI

Ultravisor Lab is a local web application that stands up the moving parts of a Retold data platform on Docker and keeps them supervised. From a single browser UI on port `44443` it provisions database-engine containers, builds and runs Ultravisor instances, attaches beacons to them, and launches whole multi-container topologies described as declarative *stacks*.

The lab process runs on the host as a Node.js application. Everything it *manages* runs in Docker. The lab drives the `docker` CLI directly: it pulls images, builds images on demand from the Retold modules in your monorepo checkout, runs containers on a shared `ultravisor-lab` docker network, and reflects their live state back into the UI through a reconcile loop.

## Why It Exists

Building a Retold data platform means running several independently-versioned services together - an Ultravisor coordinating work, beacons exposing capabilities and databases, and the database engines behind them. Wiring those up by hand (right image, right port, right config, right network, right order) is tedious and error-prone. The lab turns each of those steps into a button, tracks what is running, and tears it all down cleanly when you are done.

It is the interactive counterpart to the [Ultravisor Suite Harness](https://stevenvelozo.github.io/ultravisor-suite-harness/): the harness runs a fixed end-to-end pipeline headless and exits; the lab is a bench you keep open while you provision, iterate, and observe.

## What You Can Do

- **Spin up DB engines** - MySQL, PostgreSQL, SQL Server, MongoDB, Apache Solr, or DGraph, each in its own container with health polling and per-engine database management.
- **Run Ultravisor instances** - built on demand from the published `ultravisor` package, with a rendered config, bind-mounted state, an auto-loaded operation library, and an optional secured mode.
- **Attach beacons** - any Retold module that publishes a `retoldBeacon` stanza becomes a provisionable beacon type, built into a container image and wired to a chosen Ultravisor.
- **Launch stacks** - declarative multi-container topologies compiled to `docker-compose.yml`, with templated inputs, host preflight checks, and nine bundled presets.
- **Drive workloads** - load packaged seed datasets through a running Ultravisor, or run queue / operation load-test exercises that assert on concurrency and drain behavior.

## Two Ways To Provision

The lab offers two complementary models for getting containers running:

| Model | What it manages | Backed by | Best for |
|---|---|---|---|
| **Individual entities** | One DB engine, Ultravisor, or beacon at a time | Direct `docker run` of lab-built/pulled images, tracked in SQLite | Iterating on a single service; ad-hoc benches |
| **Stacks** | A whole topology of services together | A generated `docker-compose.yml` run via `docker compose` | Reproducible multi-service deployments; presets |

Both write their state to the same SQLite store and surface in the same UI. See [Architecture](architecture.md) for how they fit together, and [Stacks](stacks.md) for the declarative path.

## Learn More

- [Quick Start](quickstart.md) - launch the lab and bring up your first engine, Ultravisor, and stack
- [Configuration](configuration.md) - ports, the data directory, the monorepo root, and embedding the lab
- [Architecture](architecture.md) - process topology, the service layer, the state model, and the reconcile loop
- [DB Engines](db-engines.md) - the six supported engines and their container lifecycle
- [Ultravisor & Beacons](ultravisor-beacons.md) - how instances and beacons are built, run, and supervised
- [Stacks](stacks.md) - the compose-backed deployment system, the spec format, and the bundled presets
- [Web UI](web-ui.md) - the navigation, views, and chrome
- [Seed Data & Exercises](seed-data-and-exercises.md) - packaged datasets and load-test fixtures
- [REST API](api.md) - every HTTP endpoint the UI consumes

## Related Modules

| Module | Owner | Role in the lab |
|---|---|---|
| [Ultravisor](https://stevenvelozo.github.io/ultravisor/) | stevenvelozo | Workflow / operation supervisor the lab builds, runs, and seeds |
| [Ultravisor Beacon](https://stevenvelozo.github.io/ultravisor-beacon/) | stevenvelozo | Capability-provider host used by provider-mode beacons |
| [Retold Facto](https://fable-retold.github.io/retold-facto/) | stevenvelozo | A provisionable beacon type (data movement / ETL) |
| [Retold Remote](https://fable-retold.github.io/retold-remote/) | stevenvelozo | A provisionable beacon type (file browse / serve) |
| [Retold DataBeacon](https://fable-retold.github.io/retold-databeacon/) | fable-retold | A provisionable beacon type (REST over remote databases) |
| [Meadow](https://fable-retold.github.io/meadow/) | fable-retold | Data-access layer; `meadow-connection-sqlite` backs lab state |
| [Orator](https://fable-retold.github.io/orator/) | fable-retold | HTTP server (Restify) hosting the REST API + static bundle |
| [Pict](https://fable-retold.github.io/pict/) | fable-retold | MVC framework powering the browser application |
| [Fable](https://fable-retold.github.io/fable/) | fable-retold | Service-provider / DI core every lab service extends |
