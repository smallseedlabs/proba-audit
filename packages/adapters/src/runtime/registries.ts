import {
  AdapterRegistry,
  type AppConfig,
  type AuditStore,
  type Clock,
  type EventBus,
  type IdGenerator,
  type Logger,
  type MetricsStore,
} from '@smallseedlabs/proba-audit-core';
import { createClickHouseClient } from '../clickhouse/client.js';
import { ClickHouseAuditStore } from '../clickhouse/audit-store.js';
import { ClickHouseMetricsStore } from '../clickhouse/metrics-store.js';
import { InMemoryAuditStore } from '../memory/audit-store.js';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { InMemoryMetricsStore } from '../memory/metrics-store.js';
import { RedisStreamsEventBus } from '../redis/redis-streams-event-bus.js';
import { RandomIdGenerator, SystemClock } from './system.js';

/** What every adapter factory receives. */
export interface AdapterDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
}

export interface Registries {
  eventBus: AdapterRegistry<EventBus, AdapterDeps>;
  auditStore: AdapterRegistry<AuditStore, AdapterDeps>;
  metricsStore: AdapterRegistry<MetricsStore, AdapterDeps>;
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

  return { eventBus, auditStore, metricsStore };
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  eventBus: EventBus;
  auditStore: AuditStore;
  metricsStore: MetricsStore;
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
  options.logger.info('adapters created', {
    lifecycle: 'adapters_created',
    eventBus: config.adapters.eventBus,
    auditStore: config.adapters.auditStore,
    metricsStore: config.adapters.metricsStore,
  });
  return {
    config,
    logger: options.logger,
    clock: deps.clock,
    ids: deps.ids,
    eventBus,
    auditStore,
    metricsStore,
    async close() {
      await Promise.allSettled([eventBus.close(), auditStore.close(), metricsStore.close()]);
    },
  };
}
