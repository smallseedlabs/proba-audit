# proba-audit

> Audit trail and ad-metrics analytics for Proba: every service action in an append-only, hash-chained log, and ad-platform metrics normalised, revisioned and rolled up.

[![CI](https://github.com/smallseedlabs/proba-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/smallseedlabs/proba-audit/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

This is the **foundation**: ports, default adapters, config, logger, ClickHouse migrations and four runnable (but empty) processes.
Consumer, API, ingester and rollup logic come in later PRs. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Layout

```
packages/core       ports, domain types, zod config, logger, runService, contract-test helpers
packages/adapters   Redis Streams event bus, ClickHouse stores, in-memory adapters, registry, migration runner
apps/audit-consumer audit-api  metrics-ingester  rollup   (one process each, one Docker target each)
migrations/clickhouse   versioned SQL migrations
```

## Quickstart

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env           # local placeholders; .env is gitignored
docker compose up -d clickhouse redis
npm run migrate                # creates the database and applies migrations
npm test                       # unit tests (in-memory adapters)
npm run test:integration       # adapter contract tests against ClickHouse + Redis
```

Run the whole stack in containers:

```bash
docker compose --profile apps run --rm migrate
docker compose --profile apps up -d --build
curl localhost:3100/health     # audit-api   (3101 consumer, 3102 ingester, 3103 rollup)
docker compose --profile apps down
```

Run one app locally: `npm run build && node apps/audit-api/dist/index.js` (or `npm run dev:api`).
If a host port is taken, set `REDIS_HOST_PORT` / `CLICKHOUSE_HTTP_HOST_PORT` (and match `REDIS_URL` / `CLICKHOUSE_URL`).

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run build` | `tsc -b` across all workspaces |
| `npm run lint` / `typecheck` | ESLint / TypeScript (sources and tests) |
| `npm test` / `test:ci` | Unit tests (in-memory); `test:ci` fails on skipped tests |
| `npm run test:integration` | Contract + migration tests against real ClickHouse and Redis |
| `npm run migrate` | Build, then create the database and apply ClickHouse migrations |

## Swapping adapters

Backends are chosen by config: `EVENT_BUS=redis-streams|memory`, `AUDIT_STORE=clickhouse|memory`, `METRICS_STORE=clickhouse|memory`.
Adding one (for example Kafka) means one adapter, one registration and one config value; see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#how-to-swap-or-add-an-adapter-for-example-kafka).
Every adapter must pass its port's contract suite (`runEventBusContract(...)` etc. from `@smallseedlabs/proba-audit-core/testing`).

## Protocol dependency

The audit/metric contract comes from `@smallseedlabs/proba-protocol/audit` (released in proba-protocol `v0.2.0`),
installed from the release tag: `github:smallseedlabs/proba-protocol#v0.2.0`. Schemas are never copied into this repo.

## License

Apache-2.0 © Small Seed Labs
