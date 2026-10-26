import { hostname } from 'node:os';
import {
  AdapterRegistry,
  type AnchorStore,
  type AppConfig,
  type AuditContentStore,
  type AuditStore,
  type CheckpointStore,
  type ClickHouseRole,
  type Clock,
  type EventBus,
  type IdGenerator,
  type LeaseStore,
  type Logger,
  type MetricPlatform,
  type MetricsStore,
  type PlatformConnector,
  type QuarantineStore,
  type RateLimiter,
  type TokenVerifier,
} from '@smallseedlabs/proba-audit-core';
import { clickHouseOptionsFor, createClickHouseClient, type ClickHouseOptions } from '../clickhouse/client.js';
import { ClickHouseAuditStore } from '../clickhouse/audit-store.js';
import { ClickHouseAuditContentStore } from '../clickhouse/audit-content-store.js';
import { InMemoryAuditContentStore } from '../memory/audit-content-store.js';
import { ClickHouseMetricsStore } from '../clickhouse/metrics-store.js';
import { ClickHouseCheckpointStore, ClickHouseQuarantineStore } from '../clickhouse/ingest-state-stores.js';
import { InMemoryCheckpointStore } from '../memory/checkpoint-store.js';
import { InMemoryQuarantineStore } from '../memory/quarantine-store.js';
import { StubPlatformConnector, STUB_ADAPTER_NAME } from '../stub/stub-platform-connector.js';
import { InMemoryAnchorStore } from '../memory/anchor-store.js';
import { InMemoryLeaseStore } from '../memory/lease-store.js';
import { RedisLeaseStore } from '../redis/lease-store.js';
import { PostgresAnchorStore } from '../postgres/anchor-store.js';
import { InMemoryAuditStore } from '../memory/audit-store.js';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { InMemoryMetricsStore } from '../memory/metrics-store.js';
import { RedisStreamsEventBus } from '../redis/redis-streams-event-bus.js';
import { FirebaseTokenVerifier } from '../auth/firebase-token-verifier.js';
import { StaticTokenVerifier } from '../auth/static-token-verifier.js';
import { InMemoryRateLimiter } from '../ratelimit/memory-rate-limiter.js';
import { RedisRateLimiter } from '../ratelimit/redis-rate-limiter.js';
import { resolveAnchorHmacKey } from './anchor-key.js';
import { assertInMemoryAdaptersAllowed } from './in-memory-guard.js';
import { RandomIdGenerator, SystemClock } from './system.js';

/** What every adapter factory receives. */
export interface AdapterDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  /** ClickHouse connection for this process's role (CLICKHOUSE_<ROLE>_USER, falling back to CLICKHOUSE_USER). */
  clickhouse: ClickHouseOptions;
}

/** What a PlatformConnector factory receives: the shared deps plus the platform it is created for. */
export interface ConnectorDeps extends AdapterDeps {
  platform: MetricPlatform;
}

export interface Registries {
  eventBus: AdapterRegistry<EventBus, AdapterDeps>;
  auditStore: AdapterRegistry<AuditStore, AdapterDeps>;
  /** Where the raw text of audit events goes: AUDIT_CONTENT_STORE. */
  auditContentStore: AdapterRegistry<AuditContentStore, AdapterDeps>;
  /** Signed heads of the hash chains, kept outside the audit store: ANCHOR_STORE. */
  anchorStore: AdapterRegistry<AnchorStore, AdapterDeps>;
  /** Exclusive claims between replicas (one sync per account, one rollup run, one chain writer per workspace): LEASE_STORE. */
  leaseStore: AdapterRegistry<LeaseStore, AdapterDeps>;
  metricsStore: AdapterRegistry<MetricsStore, AdapterDeps>;
  checkpointStore: AdapterRegistry<CheckpointStore, AdapterDeps>;
  quarantineStore: AdapterRegistry<QuarantineStore, AdapterDeps>;
  /**
   * One adapter per ad-platform analytics library, keyed by the name used in
   * PLATFORM_CONNECTORS (meta:<name>). Register a real library's adapter here.
   */
  platformConnector: AdapterRegistry<PlatformConnector, ConnectorDeps>;
  /** Who is calling the read API: AUDIT_API_TOKEN_VERIFIER. */
  tokenVerifier: AdapterRegistry<TokenVerifier, AdapterDeps>;
  /** How the read API counts requests: AUDIT_API_RATE_LIMITER. */
  rateLimiter: AdapterRegistry<RateLimiter, AdapterDeps>;
}

/**
 * The built-in adapters. To add a backend (Kafka, Postgres, ...): write the
 * adapter, `register('kafka', factory)` on the matching registry, and set the
 * config value (EVENT_BUS=kafka). Nothing else changes.
 */
export function createDefaultRegistries(): Registries {
  const eventBus = new AdapterRegistry<EventBus, AdapterDeps>('EventBus')
    .register('redis-streams', ({ config, clock, logger }) =>
      new RedisStreamsEventBus({
        url: config.eventBus.redisUrl,
        maxStreamLength: config.eventBus.maxStreamLength,
        clock,
        logger,
      })
    )
    .register('memory', ({ clock }) => new InMemoryEventBus(clock));

  const auditStore = new AdapterRegistry<AuditStore, AdapterDeps>('AuditStore')
    .register('clickhouse', ({ clickhouse }) =>
      new ClickHouseAuditStore({ client: createClickHouseClient(clickhouse), ownsClient: true })
    )
    .register('memory', () => new InMemoryAuditStore());

  const auditContentStore = new AdapterRegistry<AuditContentStore, AdapterDeps>('AuditContentStore')
    .register('clickhouse', ({ clickhouse }) =>
      new ClickHouseAuditContentStore({ client: createClickHouseClient(clickhouse), ownsClient: true })
    )
    .register('memory', () => new InMemoryAuditContentStore());

  // Both adapters refuse to start in production without a real ANCHOR_HMAC_KEY (AnchorKeyRequiredError).
  const anchorStore = new AdapterRegistry<AnchorStore, AdapterDeps>('AnchorStore')
    .register('postgres', ({ config }) => {
      if (config.anchors.databaseUrl === '') throw new Error('ANCHOR_STORE=postgres needs ANCHOR_DATABASE_URL');
      return new PostgresAnchorStore({ connectionString: config.anchors.databaseUrl, hmacKey: resolveAnchorHmacKey(config) });
    })
    .register('memory', ({ config }) => new InMemoryAnchorStore({ hmacKey: resolveAnchorHmacKey(config) }));

  const leaseStore = new AdapterRegistry<LeaseStore, AdapterDeps>('LeaseStore')
    .register('memory', ({ clock }) => new InMemoryLeaseStore(clock))
    .register('redis', ({ config, logger }) => new RedisLeaseStore({ url: config.eventBus.redisUrl, logger }));

  const metricsStore = new AdapterRegistry<MetricsStore, AdapterDeps>('MetricsStore')
    .register('clickhouse', ({ clickhouse, clock }) =>
      new ClickHouseMetricsStore({ client: createClickHouseClient(clickhouse), clock, ownsClient: true })
    )
    .register('memory', ({ clock }) => new InMemoryMetricsStore(clock));

  const checkpointStore = new AdapterRegistry<CheckpointStore, AdapterDeps>('CheckpointStore')
    .register('clickhouse', ({ clickhouse, clock }) =>
      new ClickHouseCheckpointStore({ client: createClickHouseClient(clickhouse), clock, ownsClient: true })
    )
    .register('memory', ({ clock }) => new InMemoryCheckpointStore(clock));

  const quarantineStore = new AdapterRegistry<QuarantineStore, AdapterDeps>('QuarantineStore')
    .register('clickhouse', ({ clickhouse }) =>
      new ClickHouseQuarantineStore({ client: createClickHouseClient(clickhouse), ownsClient: true })
    )
    .register('memory', () => new InMemoryQuarantineStore());

  // The built-in connector is the development data source. A real analytics library
  // adds its own entry (see docs/ARCHITECTURE.md, "Metrics flow").
  const platformConnector = new AdapterRegistry<PlatformConnector, ConnectorDeps>('PlatformConnector').register(
    STUB_ADAPTER_NAME,
    ({ config, clock, platform }) =>
      new StubPlatformConnector({
        platform,
        clock,
        seed: config.connectors.stub.seed,
        restateEveryMinutes: config.connectors.stub.restateEveryMinutes,
        restateRevisions: config.connectors.stub.restateRevisions,
        failureRate: config.connectors.stub.failureRate,
        nodeEnv: config.env,
        allowStub: config.connectors.allowStub,
      })
  );

  // The read API (apps/audit-api). `static` exists for automated checks and local runs and refuses production.
  const tokenVerifier = new AdapterRegistry<TokenVerifier, AdapterDeps>('TokenVerifier')
    .register('firebase', ({ config }) => new FirebaseTokenVerifier({ projectId: config.api.firebaseProjectId }))
    .register('static', ({ config }) => new StaticTokenVerifier({ tokens: config.api.staticTokens, nodeEnv: config.env }));

  const rateLimiter = new AdapterRegistry<RateLimiter, AdapterDeps>('RateLimiter')
    .register('memory', ({ clock }) => new InMemoryRateLimiter(clock))
    .register('redis', ({ config, logger }) => new RedisRateLimiter({ url: config.eventBus.redisUrl, logger }));

  return { eventBus, auditStore, auditContentStore, anchorStore, leaseStore, metricsStore, checkpointStore, quarantineStore, platformConnector, tokenVerifier, rateLimiter };
}

/**
 * Create the connector for every PLATFORM_CONNECTORS pair (platform -> adapter).
 * Fails fast with the list of available adapters for an unknown name, and the
 * stub refuses to start in production without ALLOW_STUB_CONNECTOR=true.
 */
export async function createConnectors(
  config: AppConfig,
  options: { logger: Logger; clock?: Clock; ids?: IdGenerator; registries?: Registries }
): Promise<Map<MetricPlatform, PlatformConnector>> {
  const registries = options.registries ?? createDefaultRegistries();
  const deps = {
    config,
    logger: options.logger,
    clock: options.clock ?? new SystemClock(),
    ids: options.ids ?? new RandomIdGenerator(),
    clickhouse: clickHouseOptionsFor(config),
  };
  const connectors = new Map<MetricPlatform, PlatformConnector>();
  for (const { platform, adapter } of config.connectors.pairs) {
    const connector = await registries.platformConnector.create(adapter, { ...deps, platform });
    if (connector.platform !== platform) {
      throw new Error(`connector "${adapter}" serves ${connector.platform}, but PLATFORM_CONNECTORS maps it to ${platform}`);
    }
    connectors.set(platform, connector);
    options.logger.info('platform connector created', {
      lifecycle: 'connector_created',
      platform,
      adapter,
      ...(adapter === STUB_ADAPTER_NAME ? { developmentDataSource: true } : {}),
    });
  }
  return connectors;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  eventBus: EventBus;
  auditStore: AuditStore;
  /** Raw text of audit events. Only used when config.content.enabled. */
  auditContentStore: AuditContentStore;
  /** Signed chain heads. Only created with `usesAnchors` (audit-consumer, audit-api). */
  anchorStore?: AnchorStore;
  /** Leases between replicas. Only created with `usesLeases` (audit-consumer, metrics-ingester, rollup). */
  leaseStore?: LeaseStore;
  /** Identifies this process as the owner of its leases: service, host, pid and a random part, so a restarted process never inherits its predecessor's leases. */
  instanceId: string;
  metricsStore: MetricsStore;
  checkpointStore: CheckpointStore;
  quarantineStore: QuarantineStore;
  /** Close every adapter. */
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  logger: Logger;
  clock?: Clock;
  ids?: IdGenerator;
  /** Replace the built-in registries (to add adapters). */
  registries?: Registries;
  /** audit-api sets this: its rate limiter (AUDIT_API_RATE_LIMITER) counts for the in-memory production guard. */
  usesRateLimiter?: boolean;
  /**
   * audit-consumer (writes anchors) and audit-api (verifies against them) set this: they create ANCHOR_STORE, need
   * ANCHOR_HMAC_KEY in production, and refuse an in-memory anchor store in production. Other services skip all three.
   */
  usesAnchors?: boolean;
  /**
   * audit-consumer, metrics-ingester and rollup set this: they create LEASE_STORE and refuse an in-memory lease store in production
   * (a per-process lease cannot keep two replicas apart). Other services skip both.
   */
  usesLeases?: boolean;
  /**
   * The ClickHouse user this process connects as: `consumer` for the writers (audit-consumer, metrics-ingester, rollup),
   * `api` for the read-only audit-api. Omitted: the shared CLICKHOUSE_USER.
   */
  clickhouseRole?: ClickHouseRole;
}

/**
 * Build every port from config (EVENT_BUS, AUDIT_STORE, METRICS_STORE). In production it refuses in-memory
 * adapters unless ALLOW_IN_MEMORY_ADAPTERS=true (InMemoryAdaptersNotAllowedError), before anything is created.
 */
export async function createRuntime(config: AppConfig, options: CreateRuntimeOptions): Promise<Runtime> {
  assertInMemoryAdaptersAllowed(config, { includeRateLimiter: options.usesRateLimiter, includeAnchorStore: options.usesAnchors, includeLeaseStore: options.usesLeases });
  const registries = options.registries ?? createDefaultRegistries();
  const deps: AdapterDeps = {
    config,
    logger: options.logger,
    clock: options.clock ?? new SystemClock(),
    ids: options.ids ?? new RandomIdGenerator(),
    clickhouse: clickHouseOptionsFor(config, options.clickhouseRole),
  };
  const eventBus = await registries.eventBus.create(config.adapters.eventBus, deps);
  const auditStore = await registries.auditStore.create(config.adapters.auditStore, deps);
  const auditContentStore = await registries.auditContentStore.create(config.adapters.auditContentStore, deps);
  const anchorStore = options.usesAnchors ? await registries.anchorStore.create(config.adapters.anchorStore, deps) : undefined;
  const leaseStore = options.usesLeases ? await registries.leaseStore.create(config.adapters.leaseStore, deps) : undefined;
  const metricsStore = await registries.metricsStore.create(config.adapters.metricsStore, deps);
  const checkpointStore = await registries.checkpointStore.create(config.adapters.checkpointStore, deps);
  const quarantineStore = await registries.quarantineStore.create(config.adapters.quarantineStore, deps);
  options.logger.info('adapters created', {
    lifecycle: 'adapters_created',
    eventBus: config.adapters.eventBus,
    auditStore: config.adapters.auditStore,
    auditContentStore: config.adapters.auditContentStore,
    ...(anchorStore ? { anchorStore: config.adapters.anchorStore } : {}),
    ...(leaseStore ? { leaseStore: config.adapters.leaseStore } : {}),
    contentEnabled: config.content.enabled,
    metricsStore: config.adapters.metricsStore,
    checkpointStore: config.adapters.checkpointStore,
    quarantineStore: config.adapters.quarantineStore,
  });
  return {
    config,
    logger: options.logger,
    clock: deps.clock,
    ids: deps.ids,
    eventBus,
    auditStore,
    auditContentStore,
    ...(anchorStore ? { anchorStore } : {}),
    ...(leaseStore ? { leaseStore } : {}),
    instanceId: `${config.service.name}:${hostname()}:${process.pid}:${deps.ids.uuid()}`,
    metricsStore,
    checkpointStore,
    quarantineStore,
    async close() {
      await Promise.allSettled([
        eventBus.close(),
        auditStore.close(),
        auditContentStore.close(),
        anchorStore?.close(),
        leaseStore?.close(),
        metricsStore.close(),
        checkpointStore.close(),
        quarantineStore.close(),
      ]);
    },
  };
}
