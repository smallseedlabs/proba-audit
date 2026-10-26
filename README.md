# proba-audit

> Audit trail and ad-metrics analytics for Proba: every service action in an append-only, hash-chained log, and ad-platform metrics normalised, revisioned and rolled up.

[![CI](https://github.com/smallseedlabs/proba-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/smallseedlabs/proba-audit/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Ports, default adapters, config, logger and ClickHouse migrations, plus the audit consumer, the metrics ingester, the rollup worker and a
read-only HTTP API (`audit-api`) that the insights portal uses. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
npm run test:integration       # contract + end-to-end tests against ClickHouse + Redis (+ Postgres for the outbox: docker compose --profile test up -d postgres)
```

Run the whole stack in containers:

```bash
docker compose --profile apps run --rm migrate
docker compose --profile apps up -d --build
curl localhost:3100/health     # audit-api   (3101 consumer, 3102 ingester, 3103 rollup)
docker compose --profile apps down
```

### Read API

`audit-api` serves versioned, read-only routes under `/v1` (events, traces, chain verification, analytics, facets); the contract is
[docs/openapi.yaml](docs/openapi.yaml). Callers sign in with the same Firebase ID token as the Proba Hub:

```bash
# in .env: FIREBASE_PROJECT_ID, AUDIT_API_ALLOWED_EMAILS (or _DOMAINS / _ADMIN_EMAILS), AUDIT_API_CORS_ORIGINS
docker compose --profile apps up -d --build audit-api
curl -H "Authorization: Bearer $ID_TOKEN" 'localhost:3100/v1/events?outcome=failure&limit=20'
```

Nobody is allowed until an allow-list is configured. For automated local use set `AUDIT_API_TOKEN_VERIFIER=static` with `AUDIT_API_STATIC_TOKENS`
(refused when `NODE_ENV=production`). See [Read API](docs/ARCHITECTURE.md#read-api).

Run one app locally: `npm run build && node apps/audit-api/dist/index.js` (or `npm run dev:api`).
If a host port is taken, set `REDIS_HOST_PORT` / `CLICKHOUSE_HTTP_HOST_PORT` (and match `REDIS_URL` / `CLICKHOUSE_URL`).

Metrics flow on the development data source (no ad platform needed): see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#metrics-flow). In short:

```bash
docker compose --profile metrics-e2e up -d --build e2e-ingester e2e-rollup e2e-audit-consumer
docker compose --profile metrics-e2e run --rm metrics-report    # prints totals, series, comparison and the audit trail
docker compose --profile metrics-e2e down
```

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run build` | `tsc -b` across all workspaces |
| `npm run lint` / `typecheck` | ESLint / TypeScript (sources and tests) |
| `npm test` / `test:ci` | Unit tests (in-memory); `test:ci` fails on skipped tests |
| `npm run test:integration` | Contract + migration tests against real ClickHouse and Redis |
| `npm run migrate` | Build, then create the database and apply ClickHouse migrations |

## Swapping adapters

Backends are chosen by config: `EVENT_BUS=redis-streams|memory`, `AUDIT_STORE=clickhouse|memory`, `METRICS_STORE=clickhouse|memory`,
`CHECKPOINT_STORE` and `QUARANTINE_STORE` (`clickhouse|memory`), and the connector per ad platform with
`PLATFORM_CONNECTORS=meta:stub,google:stub` (swap `stub` for a real analytics library's adapter name when it exists).
Adding one (for example Kafka) means one adapter, one registration and one config value; see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#how-to-swap-or-add-an-adapter-for-example-kafka).
Every adapter must pass its port's contract suite (`runEventBusContract(...)` etc. from `@smallseedlabs/proba-audit-core/testing`).

## Protocol dependency

The audit/metric contract comes from `@smallseedlabs/proba-protocol/audit` (released in proba-protocol `v0.3.1`),
installed from the release tag: `github:smallseedlabs/proba-protocol#v0.3.1`. Schemas are never copied into this repo.

## License

Apache-2.0 © Small Seed Labs
