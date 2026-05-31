# Ultravisor Lab

> Provision dockerized engines, beacons, and Ultravisor instances from one web UI

A local web application that stands up the moving parts of a Retold data platform on Docker — database engines, Ultravisor instances, and the beacons that connect to them — and keeps them supervised, reconciled, and inspectable from a browser.

- **Dockerized DB Engines** — one-click MySQL, PostgreSQL, SQL Server, MongoDB, Solr, and DGraph containers with health polling and per-engine databases
- **Supervised Ultravisor + Beacons** — build-on-demand container images for Ultravisor and every published `retoldBeacon` module, wired to a shared docker network
- **Declarative Stacks** — multi-container topologies compiled to `docker-compose.yml`, with input templating, preflight checks, and bundled presets
- **Seed Data & Exercises** — packaged datasets and queue/operation load-test fixtures for driving real workloads through a running stack
- **State That Survives Restarts** — SQLite-backed lab state, boot-time reconcile against Docker, and auto-restart of whatever was running before shutdown

[Overview](README.md)
[Quick Start](quickstart.md)
[Architecture](architecture.md)
[GitHub](https://github.com/stevenvelozo/ultravisor-lab)
