import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  UnknownAdapterError,
  DEV_ANCHOR_HMAC_KEY,
  loadConfig,
  MemoryLogger,
  verifyAnchorSignature,
  type EventBus,
  type PlatformConnector,
} from '@smallseedlabs/proba-audit-core';
import { InMemoryCheckpointStore } from '../memory/checkpoint-store.js';
import { InMemoryQuarantineStore } from '../memory/quarantine-store.js';
import { StaticPlatformConnector } from '../memory/platform-connector.js';
import { StubConnectorNotAllowedError, StubPlatformConnector } from '../stub/stub-platform-connector.js';
import { InMemoryEventBus } from '../memory/event-bus.js';
import { InMemoryAnchorStore } from '../memory/anchor-store.js';
import { InMemoryAuditStore } from '../memory/audit-store.js';
import { InMemoryLeaseStore } from '../memory/lease-store.js';
import { InMemoryMetricsStore } from '../memory/metrics-store.js';
import { AnchorKeyRequiredError } from './anchor-key.js';
import { InMemoryAdaptersNotAllowedError } from './in-memory-guard.js';
import { createConnectors, createDefaultRegistries, createRuntime } from './registries.js';

const memoryEnv = { EVENT_BUS: 'memory', AUDIT_STORE: 'memory', METRICS_STORE: 'memory', CHECKPOINT_STORE: 'memory', QUARANTINE_STORE: 'memory' };

describe('createRuntime', () => {
  it('builds in-memory adapters from config', async () => {
    const logger = new MemoryLogger();
    const rt = await createRuntime(loadConfig(memoryEnv), { logger });
    expect(rt.eventBus).toBeInstanceOf(InMemoryEventBus);
    expect(rt.auditStore).toBeInstanceOf(InMemoryAuditStore);
    expect(rt.metricsStore).toBeInstanceOf(InMemoryMetricsStore);
    expect(rt.checkpointStore).toBeInstanceOf(InMemoryCheckpointStore);
    expect(rt.quarantineStore).toBeInstanceOf(InMemoryQuarantineStore);
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
    expect(r.checkpointStore.names()).toEqual(['clickhouse', 'memory']);
    expect(r.quarantineStore.names()).toEqual(['clickhouse', 'memory']);
    expect(r.anchorStore.names()).toEqual(['memory', 'postgres']);
    expect(r.leaseStore.names()).toEqual(['memory', 'redis']);
    expect(r.platformConnector.names()).toEqual(['stub']);
  });
});

describe('in-memory adapters in production (ALLOW_IN_MEMORY_ADAPTERS)', () => {
  const prod = (extra: Record<string, string> = {}) => loadConfig({ ...memoryEnv, AUDIT_CONTENT_STORE: 'memory', NODE_ENV: 'production', ...extra });
  // Everything durable except the one adapter under test, so a refusal names exactly that adapter.
  const durable = { EVENT_BUS: 'redis-streams', AUDIT_STORE: 'clickhouse', METRICS_STORE: 'clickhouse', CHECKPOINT_STORE: 'clickhouse', QUARANTINE_STORE: 'clickhouse', AUDIT_CONTENT_STORE: 'clickhouse' };

  it('refuses to start in production with any in-memory adapter, naming each', async () => {
    const err = await createRuntime(prod(), { logger: new MemoryLogger() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect((err as InMemoryAdaptersNotAllowedError).adapters).toEqual([
      'EVENT_BUS',
      'AUDIT_STORE',
      'METRICS_STORE',
      'CHECKPOINT_STORE',
      'QUARANTINE_STORE',
      'AUDIT_CONTENT_STORE',
    ]);
    expect((err as Error).message).toContain('ALLOW_IN_MEMORY_ADAPTERS=true');
  });

  it.each(['EVENT_BUS', 'AUDIT_STORE', 'METRICS_STORE', 'CHECKPOINT_STORE', 'QUARANTINE_STORE', 'AUDIT_CONTENT_STORE'])(
    'a single in-memory %s is enough to refuse',
    async (key) => {
      const config = loadConfig({ ...durable, [key]: 'memory', NODE_ENV: 'production' });
      const err = await createRuntime(config, { logger: new MemoryLogger() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InMemoryAdaptersNotAllowedError);
      expect((err as InMemoryAdaptersNotAllowedError).adapters).toEqual([key]);
    }
  );

  it('refuses before creating any adapter', async () => {
    const registries = createDefaultRegistries();
    let created = false;
    registries.eventBus.register('probe', () => {
      created = true;
      return new InMemoryEventBus() as EventBus;
    });
    await expect(createRuntime(prod({ EVENT_BUS: 'probe' }), { logger: new MemoryLogger(), registries })).rejects.toBeInstanceOf(InMemoryAdaptersNotAllowedError);
    expect(created).toBe(false);
  });

  it('the rate limiter counts only for the read API (usesRateLimiter)', async () => {
    const config = (limiter: string) => prod({ ALLOW_IN_MEMORY_ADAPTERS: 'false', AUDIT_API_RATE_LIMITER: limiter });
    const refused = async (limiter: string, usesRateLimiter: boolean) =>
      ((await createRuntime(config(limiter), { logger: new MemoryLogger(), usesRateLimiter }).catch((e: unknown) => e)) as InMemoryAdaptersNotAllowedError).adapters;
    expect(await refused('memory', true)).toContain('AUDIT_API_RATE_LIMITER');
    expect(await refused('memory', false)).not.toContain('AUDIT_API_RATE_LIMITER');
    expect(await refused('redis', true)).not.toContain('AUDIT_API_RATE_LIMITER');
  });

  it('starts in production with ALLOW_IN_MEMORY_ADAPTERS=true', async () => {
    const rt = await createRuntime(prod({ ALLOW_IN_MEMORY_ADAPTERS: 'true' }), { logger: new MemoryLogger() });
    expect(rt.auditStore).toBeInstanceOf(InMemoryAuditStore);
    await rt.close();
  });

  it('is allowed outside production without the opt-in', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      const rt = await createRuntime(loadConfig({ ...memoryEnv, NODE_ENV }), { logger: new MemoryLogger() });
      await rt.close();
    }
  });

  it('defaults to false and accepts only true or false', () => {
    expect(loadConfig({}).allowInMemoryAdapters).toBe(false);
    expect(loadConfig({ ALLOW_IN_MEMORY_ADAPTERS: 'true' }).allowInMemoryAdapters).toBe(true);
    expect(() => loadConfig({ ALLOW_IN_MEMORY_ADAPTERS: 'yes' })).toThrow(ConfigError);
  });
});

describe('chain anchors (ANCHOR_STORE, ANCHOR_HMAC_KEY)', () => {
  const REAL_KEY = 'k'.repeat(48);
  const prod = (extra: Record<string, string> = {}) => loadConfig({ ...memoryEnv, AUDIT_CONTENT_STORE: 'memory', NODE_ENV: 'production', ALLOW_IN_MEMORY_ADAPTERS: 'true', ...extra });
  const failure = async (config: ReturnType<typeof loadConfig>, usesAnchors = true) =>
    createRuntime(config, { logger: new MemoryLogger(), usesAnchors }).catch((e: unknown) => e);

  it('creates the anchor store only for services that use it', async () => {
    const config = loadConfig({ ...memoryEnv, NODE_ENV: 'development' });
    const without = await createRuntime(config, { logger: new MemoryLogger() });
    expect(without.anchorStore).toBeUndefined();
    await without.close();
    const withAnchors = await createRuntime(config, { logger: new MemoryLogger(), usesAnchors: true });
    expect(withAnchors.anchorStore).toBeInstanceOf(InMemoryAnchorStore);
    await withAnchors.close();
  });

  it('outside production an empty key falls back to the development key', async () => {
    const rt = await createRuntime(loadConfig({ ...memoryEnv, NODE_ENV: 'development' }), { logger: new MemoryLogger(), usesAnchors: true });
    const anchor = await rt.anchorStore!.put({ workspaceId: 'w', headHash: 'h', count: 1, timestamp: '2026-10-25T10:00:00.000Z' });
    expect(verifyAnchorSignature(DEV_ANCHOR_HMAC_KEY, anchor)).toBe(true);
    await rt.close();
  });

  it('production needs ANCHOR_HMAC_KEY (empty, too short and the public development key are refused)', async () => {
    for (const key of ['', 'short', DEV_ANCHOR_HMAC_KEY]) {
      const err = await failure(prod({ ANCHOR_HMAC_KEY: key }));
      expect(err).toBeInstanceOf(AnchorKeyRequiredError);
      expect((err as Error).message).toContain('ANCHOR_HMAC_KEY');
    }
  });

  it('production starts with a real key, which signs the anchors', async () => {
    const rt = await createRuntime(prod({ ANCHOR_HMAC_KEY: REAL_KEY }), { logger: new MemoryLogger(), usesAnchors: true });
    const anchor = await rt.anchorStore!.put({ workspaceId: 'w', headHash: 'h', count: 1, timestamp: '2026-10-25T10:00:00.000Z' });
    expect(verifyAnchorSignature(REAL_KEY, anchor)).toBe(true);
    expect(verifyAnchorSignature(DEV_ANCHOR_HMAC_KEY, anchor)).toBe(false);
    await rt.close();
  });

  it('services that do not use anchors do not need the key', async () => {
    const rt = await createRuntime(prod(), { logger: new MemoryLogger() });
    await rt.close();
  });

  it('an in-memory anchor store counts for the production guard only with usesAnchors', async () => {
    const config = prod({ ALLOW_IN_MEMORY_ADAPTERS: 'false', ANCHOR_HMAC_KEY: REAL_KEY });
    const refused = async (usesAnchors: boolean) =>
      ((await failure(config, usesAnchors)) as InMemoryAdaptersNotAllowedError).adapters;
    expect(await refused(true)).toContain('ANCHOR_STORE');
    expect(await refused(false)).not.toContain('ANCHOR_STORE');
  });

  it('ANCHOR_STORE=postgres needs ANCHOR_DATABASE_URL', async () => {
    const err = await failure(loadConfig({ ...memoryEnv, NODE_ENV: 'development', ANCHOR_STORE: 'postgres' }));
    expect((err as Error).message).toContain('ANCHOR_DATABASE_URL');
  });
});

describe('leases (LEASE_STORE)', () => {
  const prod = (extra: Record<string, string> = {}) => loadConfig({ ...memoryEnv, AUDIT_CONTENT_STORE: 'memory', NODE_ENV: 'production', ...extra });

  it('creates the lease store only for services that take leases, with a distinct instance id per runtime', async () => {
    const config = loadConfig({ ...memoryEnv, NODE_ENV: 'development' });
    const without = await createRuntime(config, { logger: new MemoryLogger() });
    expect(without.leaseStore).toBeUndefined();
    const a = await createRuntime(config, { logger: new MemoryLogger(), usesLeases: true });
    const b = await createRuntime(config, { logger: new MemoryLogger(), usesLeases: true });
    expect(a.leaseStore).toBeInstanceOf(InMemoryLeaseStore);
    expect(a.instanceId).not.toBe(b.instanceId);
    await Promise.all([without.close(), a.close(), b.close()]);
  });

  it('an in-memory lease store counts for the production guard only with usesLeases', async () => {
    const config = prod({ ALLOW_IN_MEMORY_ADAPTERS: 'false' });
    const refused = async (usesLeases: boolean) =>
      ((await createRuntime(config, { logger: new MemoryLogger(), usesLeases }).catch((e: unknown) => e)) as InMemoryAdaptersNotAllowedError).adapters;
    expect(await refused(true)).toContain('LEASE_STORE');
    expect(await refused(false)).not.toContain('LEASE_STORE');
  });

  it('an unknown LEASE_STORE fails with the list of adapters', async () => {
    await expect(
      createRuntime(loadConfig({ ...memoryEnv, NODE_ENV: 'development', LEASE_STORE: 'etcd' }), { logger: new MemoryLogger(), usesLeases: true })
    ).rejects.toThrow(UnknownAdapterError);
  });
});

describe('createConnectors (PLATFORM_CONNECTORS)', () => {
  const env = (extra: Record<string, string> = {}) => loadConfig({ ...memoryEnv, NODE_ENV: 'development', ...extra });

  it('creates nothing when PLATFORM_CONNECTORS is empty', async () => {
    expect((await createConnectors(env(), { logger: new MemoryLogger() })).size).toBe(0);
  });

  it('maps platform:adapter pairs to connectors for that platform', async () => {
    const logger = new MemoryLogger();
    const connectors = await createConnectors(env({ PLATFORM_CONNECTORS: 'meta:stub,google:stub' }), { logger });
    expect([...connectors.keys()]).toEqual(['meta', 'google']);
    expect(connectors.get('meta')).toBeInstanceOf(StubPlatformConnector);
    expect(connectors.get('google')?.platform).toBe('google');
    expect(logger.records.filter((r) => r.fields.lifecycle === 'connector_created')).toHaveLength(2);
    expect(logger.records.every((r) => r.fields.developmentDataSource === undefined || r.fields.adapter === 'stub')).toBe(true);
  });

  it('an unknown adapter fails with the available names', async () => {
    const err = await createConnectors(env({ PLATFORM_CONNECTORS: 'meta:meta-lib' }), { logger: new MemoryLogger() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownAdapterError);
    expect((err as Error).message).toContain('stub');
  });

  it('swapping the stub for a real analytics library is one registration plus one config value', async () => {
    const registries = createDefaultRegistries();
    registries.platformConnector.register('meta-lib', ({ platform }) => new StaticPlatformConnector(platform, []) as PlatformConnector);
    const connectors = await createConnectors(env({ PLATFORM_CONNECTORS: 'meta:meta-lib,google:stub' }), { logger: new MemoryLogger(), registries });
    expect(connectors.get('meta')).toBeInstanceOf(StaticPlatformConnector);
    expect(connectors.get('google')).toBeInstanceOf(StubPlatformConnector);
  });

  it('rejects an adapter that serves another platform than the one it is mapped to', async () => {
    const registries = createDefaultRegistries();
    registries.platformConnector.register('wrong', () => new StaticPlatformConnector('google', []) as PlatformConnector);
    await expect(createConnectors(env({ PLATFORM_CONNECTORS: 'meta:wrong' }), { logger: new MemoryLogger(), registries })).rejects.toThrow(/serves google/);
  });

  it('the stub refuses to start in production unless ALLOW_STUB_CONNECTOR=true', async () => {
    const prod = { NODE_ENV: 'production', PLATFORM_CONNECTORS: 'meta:stub' };
    await expect(createConnectors(loadConfig({ ...memoryEnv, ...prod }), { logger: new MemoryLogger() })).rejects.toBeInstanceOf(StubConnectorNotAllowedError);
    const allowed = await createConnectors(loadConfig({ ...memoryEnv, ...prod, ALLOW_STUB_CONNECTOR: 'true' }), { logger: new MemoryLogger() });
    expect(allowed.get('meta')).toBeInstanceOf(StubPlatformConnector);
  });

  it('rejects malformed PLATFORM_CONNECTORS at config load', () => {
    for (const bad of ['meta', 'meta:', 'tiktok:stub', 'meta:stub,meta:other', 'meta:stub:extra', 'meta:Stub']) {
      expect(() => loadConfig({ ...memoryEnv, PLATFORM_CONNECTORS: bad })).toThrow(ConfigError);
    }
  });
});
