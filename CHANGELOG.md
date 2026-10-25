# Changelog

All notable changes to proba-audit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Audit pipeline: `AuditEmitter` port with bus and outbox emitters, `OutboxStore` port
  (`InMemoryOutboxStore`, `PostgresOutboxStore` + `migrations/postgres/0001_audit_outbox.sql`),
  `OutboxRelay`, `verifyChain`, `AuditedReader`, and the `audit-consumer` app (consumer group,
  validate, dedupe by `eventId` and content hash, derived tags, per-workspace hash chain,
  XACK after the durable write, DLQ, graceful shutdown, pending reclaim, self-audit events).
- `AuditStore.findExisting` and `AuditStore.readChain`; `AppendResult.conflicts`.
- ClickHouse migration `0004` (`fsync_after_insert` on `audit_events`).
- Postgres service for the outbox integration tests (compose profile `test`, CI service).
- npm workspaces monorepo: `packages/core`, `packages/adapters` and the apps
  `audit-consumer`, `audit-api`, `metrics-ingester`, `rollup` (foundation only:
  each loads config, logs its lifecycle, serves `/health` and exits cleanly on SIGTERM).
- Ports (`EventBus`, `AuditStore`, `MetricsStore`, `Clock`, `IdGenerator`, `Logger`,
  `PlatformConnector`) with a contract-test helper per port (`runEventBusContract`, ...).
- Default adapters: `RedisStreamsEventBus` (consumer groups, XACK, pending reclaim,
  dead-letter stream), `ClickHouseAuditStore`, `ClickHouseMetricsStore`, and in-memory
  implementations of every port. Selected by config (`EVENT_BUS`, `AUDIT_STORE`,
  `METRICS_STORE`) through an adapter registry.
- zod-validated environment config and a structured JSON logger (pino) with a hook
  point for a future audit emitter.
- Versioned ClickHouse migration runner (`schema_migrations` table) and migrations for
  `audit_events`, `metric_observations` and hourly/daily rollup tables.
- `docker-compose.yml` (ClickHouse, Redis with AOF, apps behind the `apps` profile),
  a multi-target Dockerfile, CI (lint, typecheck, unit tests, integration tests, Docker builds).
- `docs/ARCHITECTURE.md`.

### Notes

- Depends on `@smallseedlabs/proba-protocol` pinned to a commit of the unmerged PR #4
  (see `PROTOCOL_PIN_NOTE.md`); switch to the `v0.2.0` tag once released.
