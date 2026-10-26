# Changelog

All notable changes to proba-audit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Reads are recorded with the protocol's specific actions instead of `data_access.read` / `data_access.audit_*` / `data_access.metrics_*`: `audit.searched`, `audit.event_viewed`,
  `audit.trace_viewed`, `audit.integrity_checked`, `analytics.queried`, `analytics.compared` (needs protocol 0.3.2+). `/v1/session` is no longer recorded. A test checks every emitted action against `AUDIT_ACTION_INFO`.

### Added

- Raw text of audit events (protocol 0.3.3 `AuditEvent.content`), off by default (`AUDIT_CONTENT_ENABLED`, `AUDIT_CONTENT_STORE`): `AuditContentStore` port with ClickHouse (`audit_event_content`,
  migration `0008`, own table so it can have its own retention and grants) and memory adapters and a contract suite; the consumer stores the text there and only a SHA-256
  `contentDigest` in `audit_events`, covered by the hash chain; `verifyChain` can compare stored text with the digest (`content_mismatch`; text removed by retention counts as missing);
  audit-api `GET /v1/events/{id}/content` and `/v1/traces/{id}/content` for administrators only, each read audited (`audit.event_viewed` / `audit.trace_viewed`, `contentIncluded: true`),
  `hasContent` on events, digest shown to administrators only. Tests for gating, digest and tamper detection, flag off, idempotence.

- `audit-api`: a Fastify, read-only HTTP API under `/v1`: event search with every filter, cursor pagination and a hard page cap, event by id, trace list and
  span-tree view, bounded chain verification (admin), analytics summary / compare / top campaigns with data freshness, facets, `/health` and `/ready`.
  Zod-validated query parameters (no free SQL, unknown parameters rejected), workspace scope injected from the authenticated session, Firebase ID token
  verification through a `TokenVerifier` port (Firebase and static adapters), allow-list/domain and viewer/admin authorisation from configuration, every call audited
  (`data_access.read`, `data_access.metrics_*`, `auth.denied`), a `RateLimiter` port (memory and Redis adapters), CORS allow-list, `X-Trace-Id` on every response.
  `docs/openapi.yaml`, kept in sync by a test.
- `AuditStore.search`, `getEvent`, `listTraces`, `facets` and `MetricsStore.getFreshness` (memory and ClickHouse, with contract suites); `buildTraceTree`;
  `verifyChain` `maxEvents` bound; ClickHouse migration `0007` (skip indexes for event id, campaign, action, ingestion time).

- Metrics flow on a development data source: the finalised `PlatformConnector` port (accounts, campaigns, incremental
  `fetchObservations` by cursor, capabilities, typed rate-limit/transient/auth errors, `runPlatformConnectorContract`),
  `StubPlatformConnector` (deterministic from seed and clock, per-account timezone, controllable restatements, injectable faults,
  `stub:` source refs, refuses production unless `ALLOW_STUB_CONNECTOR=true`), and `PLATFORM_CONNECTORS=meta:stub,google:stub`.
- `metrics-ingester`: per (platform, account) scheduler with jitter, overlap lease and failure backoff; `SyncEngine` with incremental
  windows, retries with backoff, rate-limit hints, protocol validation, quarantine, idempotent writes, checkpoints written after the data
  is durable, one `traceId` per run, and `metrics.fetch_started|ingested|restated|fetch_completed|fetch_failed` audit events.
- `CheckpointStore` and `QuarantineStore` ports (memory and ClickHouse), ClickHouse migration `0005` (`ingest_checkpoints`,
  `metric_observation_quarantine`) and `0006` (`timezone`, `bucket_date` on daily rollups).
- `rollup`: `RollupWorker` driven by `MetricsStore.changedSince`, hourly and daily rollups per campaign and account, daily buckets in the account
  timezone, restatement-correct sums, `metrics.rollup_run` events. `MetricsStore.aggregateRollups` and `changedSince`.
- Analytics read functions `MetricsAnalytics.getMetricsSummary` and `comparePeriods` (strict validation and caps), `AuditedAnalyticsReader`
  with an injected `ScopeResolver` (`data_access.metrics_summary` / `data_access.metrics_compare`).
- Compose profile `metrics-e2e` and the `metrics-report` target; "Metrics flow" in `docs/ARCHITECTURE.md`.

### Changed

- proba-audit pins proba-protocol `v0.3.1`.
- `StaticPlatformConnector` implements the new port.

### Fixed

- `audit-consumer` recreates the stream and consumer group when they disappear while it is running (NOGROUP).

### Added (earlier)

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

### Changed

- Depend on `@smallseedlabs/proba-protocol` at the `v0.2.0` release tag (was a commit of then-unmerged PR #4).
