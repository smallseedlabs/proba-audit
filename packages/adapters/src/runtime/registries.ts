import {
  AdapterRegistry,
  type AppConfig,
  type AuditStore,
  type CheckpointStore,
  type Clock,
  type EventBus,
  type IdGenerator,
  type Logger,
  type MetricPlatform,
  type MetricsStore,
  type PlatformConnector,
  type QuarantineStore,
  type RateLimiter,
  type TokenVerifier,
} from '@smallseedlabs/proba-audit-core';
import { createClickHouseClient } from '../clickhouse/client.js';
import { ClickHouseAuditStore } from '../clickhouse/audit-store.js';
import { ClickHouseMetricsStore } from '../clickhouse/metrics-store.js';
import { ClickHouseCheckpointStore, ClickHouseQuarantineStore } from '../clickhouse/ingest-state-stores.js';
import { InMemoryCheckpointStore } from '../memory/checkpoint-store.js';
import { InMemoryQuarantineStore } from '../memory/quarantine-store.js';
import { StubPlatformConnector, STUB_ADAPTER_NAME } from '../stub/stub-platform-connector.js';
import { InMemoryAuditStore } from '../memory/audit-store.js';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { InMemoryMetricsStore } from '../memory/metrics-store.js';
import { RedisStreamsEventBus } from '../redis/redis-streams-event-bus.js';
import { FirebaseTokenVerifier } from '../auth/firebase-token-verifier.js';
import { StaticTokenVerifier } from '../auth/static-token-verifier.js';
import { InMemoryRateLimiter } from '../ratelimit/memory-rate-limiter.js';
import { RedisRateLimiter } from '../ratelimit/redis-rate-limiter.js';
import { RandomIdGenerator, SystemClock } from './system.js';

/** What every adapter factory receives. */
export interface AdapterDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
}

/** What a PlatformConnector factory receives: the shared deps plus the platform it is created for. */
export interface ConnectorDeps extends AdapterDeps {
  platform: MetricPlatform;
}

export interface Registries {
  eventBus: AdapterRegistry<EventBus, AdapterDeps>;
  auditStore: AdapterRegistry<AuditStore, AdapterDeps>;
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
    .register('clickhouse', ({ config }) =>
      new ClickHouseAuditStore({ client: createClickHouseClient(config.clickhouse), ownsClient: true })
    )
    .register('memory', () => new InMemoryAuditStore());

  const metricsStore = new AdapterRegistry<MetricsStore, AdapterDeps>('MetricsStore')
    .register('clickhouse', ({ config, clock }) =>
      new ClickHouseMetricsStore({ client: createClickHouseClient(config.clickhouse), clock, ownsClient: true })
    )
    .register('memory', ({ clock }) => new InMemoryMetricsStore(clock));

  const checkpointStore = new AdapterRegistry<CheckpointStore, AdapterDeps>('CheckpointStore')
    .register('clickhouse', ({ config, clock }) =>
      new ClickHouseCheckpointStore({ client: createClickHouseClient(config.clickhouse), clock, ownsClient: true })
    )
    .register('memory', ({ clock }) => new InMemoryCheckpointStore(clock));

  const quarantineStore = new AdapterRegistry<QuarantineStore, AdapterDeps>('QuarantineStore')
    .register('clickhouse', ({ config }) =>
      new ClickHouseQuarantineStore({ client: createClickHouseClient(config.clickhouse), ownsClient: true })
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

  return { eventBus, auditStore, metricsStore, checkpointStore, quarantineStore, platformConnector, tokenVerifier, rateLimiter };
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
}

/** Build every port from config (EVENT_BUS, AUDIT_STORE, METRICS_STORE). */
export async function createRuntime(config: AppConfig, options: CreateRuntimeOptions): Promise<Runtime> {
  const registries = options.registries ?? createDefaultRegistries();
  const deps: AdapterDeps = {
    config,
    logger: options.logger,
    clock: options.clock ?? new SystemClock(),
    ids: options.ids ?? new RandomIdGenerator(),
  };
  const eventBus = await registries.eventBus.create(config.adapters.eventBus, deps);
  const auditStore = await registries.auditStore.create(config.adapters.auditStore, deps);
  const metricsStore = await registries.metricsStore.create(config.adapters.metricsStore, deps);
  const checkpointStore = await registries.checkpointStore.create(config.adapters.checkpointStore, deps);
  const quarantineStore = await registries.quarantineStore.create(config.adapters.quarantineStore, deps);
  options.logger.info('adapters created', {
    lifecycle: 'adapters_created',
    eventBus: config.adapters.eventBus,
    auditStore: config.adapters.auditStore,
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
    metricsStore,
    checkpointStore,
    quarantineStore,
    async close() {
      await Promise.allSettled([
        eventBus.close(),
        auditStore.close(),
        metricsStore.close(),
        checkpointStore.close(),
        quarantineStore.close(),
      ]);
    },
  };
}
