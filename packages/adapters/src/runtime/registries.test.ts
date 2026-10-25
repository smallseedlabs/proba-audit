import { describe, expect, it } from 'vitest';
import { UnknownAdapterError, loadConfig, MemoryLogger, type EventBus } from '@smallseedlabs/proba-audit-core';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { InMemoryAuditStore } from '../memory/audit-store.js';
import { InMemoryMetricsStore } from '../memory/metrics-store.js';
import { createDefaultRegistries, createRuntime } from './registries.js';

const memoryEnv = { EVENT_BUS: 'memory', AUDIT_STORE: 'memory', METRICS_STORE: 'memory' };

describe('createRuntime', () => {
  it('builds in-memory adapters from config', async () => {
    const logger = new MemoryLogger();
    const rt = await createRuntime(loadConfig(memoryEnv), { logger });
    expect(rt.eventBus).toBeInstanceOf(InMemoryEventBus);
    expect(rt.auditStore).toBeInstanceOf(InMemoryAuditStore);
    expect(rt.metricsStore).toBeInstanceOf(InMemoryMetricsStore);
    expect(logger.records.some((r) => r.fields.lifecycle === 'adapters_created')).toBe(true);
    await rt.close();
  });

  it('can mix adapters', async () => {
    const rt = await createRuntime(loadConfig({ ...memoryEnv, AUDIT_STORE: 'memory' }), { logger: new MemoryLogger() });
    await expect(rt.eventBus.ping()).resolves.toBeUndefined();
    await rt.close();
  });

  it('fails with the list of available adapters for an unknown name', async () => {
    await expect(createRuntime(loadConfig({ ...memoryEnv, EVENT_BUS: 'kafka' }), { logger: new MemoryLogger() })).rejects.toThrow(
      UnknownAdapterError
    );
  });

  it('adding a backend is one registration plus one config value', async () => {
    const registries = createDefaultRegistries();
    let created = false;
    registries.eventBus.register('fake-kafka', () => {
      created = true;
      return new InMemoryEventBus() as EventBus;
    });
    const rt = await createRuntime(loadConfig({ ...memoryEnv, EVENT_BUS: 'fake-kafka' }), { logger: new MemoryLogger(), registries });
    expect(created).toBe(true);
    await rt.close();
  });

  it('registers the documented defaults', () => {
    const r = createDefaultRegistries();
    expect(r.eventBus.names()).toEqual(['memory', 'redis-streams']);
    expect(r.auditStore.names()).toEqual(['clickhouse', 'memory']);
    expect(r.metricsStore.names()).toEqual(['clickhouse', 'memory']);
  });
});
