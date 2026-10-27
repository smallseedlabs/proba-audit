import { describe, expect, it } from 'vitest';
import { MemoryLogger, loadConfig } from '@smallseedlabs/proba-audit-core';
import {
  ClickHouseRoleError,
  RedisPasswordRequiredError,
  assertClickHouseRoleSafe,
  assertRedisAuthenticated,
} from './production-guards.js';
import { createRuntime } from './registries.js';

// Everything durable, as a real deployment; the tests change one thing at a time.
const prodEnv = {
  NODE_ENV: 'production',
  EVENT_BUS: 'redis-streams',
  AUDIT_STORE: 'clickhouse',
  METRICS_STORE: 'clickhouse',
  CHECKPOINT_STORE: 'clickhouse',
  QUARANTINE_STORE: 'clickhouse',
  AUDIT_CONTENT_STORE: 'clickhouse',
  LEASE_STORE: 'redis',
  AUDIT_API_RATE_LIMITER: 'redis',
  REDIS_URL: 'redis://proba:redis-pw@redis:6379',
  CLICKHOUSE_USER: 'proba',
  CLICKHOUSE_PASSWORD: 'admin-pw',
  CLICKHOUSE_CONSUMER_PASSWORD: 'consumer-pw',
  CLICKHOUSE_API_PASSWORD: 'api-pw',
  CLICKHOUSE_MIGRATOR_PASSWORD: 'migrator-pw',
  ANCHOR_STORE: 'postgres',
  ANCHOR_DATABASE_URL: 'postgresql://a:b@anchor-db:5432/a',
  ANCHOR_HMAC_KEY: 'k'.repeat(40),
};
const prod = (extra: Record<string, string> = {}) => loadConfig({ ...prodEnv, ...extra });
// Outside production a role password needs its own user name (there is no default user).
const roleUsers = { CLICKHOUSE_CONSUMER_USER: 'proba_consumer', CLICKHOUSE_API_USER: 'proba_api', CLICKHOUSE_MIGRATOR_USER: 'proba_migrator' };

describe('Redis authentication guard (production)', () => {
  it.each([
    'redis://redis:6379',
    'redis://proba@redis:6379',
    'redis://proba:@redis:6379',
    'rediss://cache.example.com:6380',
  ])('refuses a Redis URL without a password: %s', (url) => {
    expect(() => assertRedisAuthenticated(prod({ REDIS_URL: url }))).toThrow(RedisPasswordRequiredError);
  });

  it('names what uses Redis and never prints the URL', () => {
    const err = (() => {
      try {
        assertRedisAuthenticated(prod({ REDIS_URL: 'redis://redis:6379' }), { usesLeases: true, usesRateLimiter: true });
        return undefined;
      } catch (e) {
        return e as RedisPasswordRequiredError;
      }
    })();
    expect(err).toBeInstanceOf(RedisPasswordRequiredError);
    expect(err!.users).toEqual(['EVENT_BUS=redis-streams', 'LEASE_STORE=redis', 'AUDIT_API_RATE_LIMITER=redis']);
    expect(err!.message).toContain('REDIS_URL');
  });

  it('accepts a password, plain or TLS', () => {
    expect(() => assertRedisAuthenticated(prod())).not.toThrow();
    expect(() => assertRedisAuthenticated(prod({ REDIS_URL: 'rediss://:pw@cache.example.com:6380' }))).not.toThrow();
  });

  it('does not apply outside production', () => {
    expect(() => assertRedisAuthenticated(prod({ ...roleUsers, NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' }))).not.toThrow();
    expect(() => assertRedisAuthenticated(prod({ ...roleUsers, NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' }))).not.toThrow();
  });

  it('does not apply when nothing uses Redis', () => {
    const config = prod({ EVENT_BUS: 'memory', REDIS_URL: 'redis://redis:6379' });
    expect(() => assertRedisAuthenticated(config)).not.toThrow();
    // The lease store and the rate limiter only count for the services that use them.
    expect(() => assertRedisAuthenticated(prod({ EVENT_BUS: 'memory', REDIS_URL: 'redis://redis:6379' }), { usesLeases: true })).toThrow(RedisPasswordRequiredError);
  });

  it('createRuntime refuses before creating any adapter', async () => {
    const err = await createRuntime(prod({ REDIS_URL: 'redis://redis:6379' }), { logger: new MemoryLogger(), clickhouseRole: 'consumer' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisPasswordRequiredError);
  });
});

describe('ClickHouse role guard (production)', () => {
  it.each(['consumer', 'api'] as const)('%s refuses to start with an empty password', (role) => {
    const env: Record<string, string> = role === 'consumer' ? { CLICKHOUSE_CONSUMER_PASSWORD: '' } : { CLICKHOUSE_API_PASSWORD: '' };
    const config = prod(env);
    expect(config.clickhouse.roles[role].password).toBe('');
    const err = (() => {
      try {
        assertClickHouseRoleSafe(config, { clickhouseRole: role });
        return undefined;
      } catch (e) {
        return e as ClickHouseRoleError;
      }
    })();
    expect(err).toBeInstanceOf(ClickHouseRoleError);
    expect(err!.problems.join()).toContain(`CLICKHOUSE_${role.toUpperCase()}_PASSWORD is empty`);
  });

  it.each([
    ['the shared admin user', { CLICKHOUSE_CONSUMER_USER: 'proba' }, 'consumer', /admin user CLICKHOUSE_USER/],
    ['the default user', { CLICKHOUSE_CONSUMER_USER: 'default' }, 'consumer', /administrator name/],
    ['the migrator user', { CLICKHOUSE_CONSUMER_USER: 'proba_migrator', CLICKHOUSE_MIGRATOR_USER: 'proba_migrator' }, 'consumer', /migrator user/],
    ['the admin user', { CLICKHOUSE_API_USER: 'proba' }, 'api', /admin user CLICKHOUSE_USER/],
    ['the migrator user', { CLICKHOUSE_API_USER: 'proba_migrator' }, 'api', /migrator user/],
    ['the write user', { CLICKHOUSE_API_USER: 'proba_consumer' }, 'api', /consumer \(write\) user/],
  ] as const)('%s is refused', (_name, env, role, message) => {
    const withPassword = { ...env, ...(role === 'consumer' ? { CLICKHOUSE_CONSUMER_PASSWORD: 'x' } : { CLICKHOUSE_API_PASSWORD: 'x' }) };
    expect(() => assertClickHouseRoleSafe(prod(withPassword), { clickhouseRole: role })).toThrow(message);
  });

  it('production defaults give each role its own user, so a correct deployment passes', () => {
    const config = prod();
    expect(config.clickhouse.roles.consumer.username).toBe('proba_consumer');
    expect(config.clickhouse.roles.api.username).toBe('proba_api');
    expect(() => assertClickHouseRoleSafe(config, { clickhouseRole: 'consumer' })).not.toThrow();
    expect(() => assertClickHouseRoleSafe(config, { clickhouseRole: 'api' })).not.toThrow();
  });

  it('a role user without a password is refused in every environment (the connection could only fail); the shared-user fallback is fine', () => {
    const dev = prod({ ...roleUsers, NODE_ENV: 'development', CLICKHOUSE_CONSUMER_PASSWORD: '' });
    expect(() => assertClickHouseRoleSafe(dev, { clickhouseRole: 'consumer' })).toThrow(/CLICKHOUSE_CONSUMER_PASSWORD is empty/);
    const fallback = loadConfig({ NODE_ENV: 'development', EVENT_BUS: 'memory', AUDIT_STORE: 'clickhouse', CLICKHOUSE_USER: 'proba', CLICKHOUSE_PASSWORD: 'pw' });
    expect(() => assertClickHouseRoleSafe(fallback, { clickhouseRole: 'consumer' })).not.toThrow();
  });

  it('does not apply outside production, to the migrator, or without ClickHouse stores', () => {
    const dev = prod({ ...roleUsers, NODE_ENV: 'development', CLICKHOUSE_CONSUMER_USER: 'proba', CLICKHOUSE_CONSUMER_PASSWORD: 'admin-pw' });
    expect(() => assertClickHouseRoleSafe(dev, { clickhouseRole: 'consumer' })).not.toThrow();
    expect(() => assertClickHouseRoleSafe(prod(), { clickhouseRole: 'migrator' })).not.toThrow();
    const memory = prod({ AUDIT_STORE: 'memory', METRICS_STORE: 'memory', CHECKPOINT_STORE: 'memory', QUARANTINE_STORE: 'memory', AUDIT_CONTENT_STORE: 'memory', CLICKHOUSE_CONSUMER_PASSWORD: '' });
    expect(() => assertClickHouseRoleSafe(memory, { clickhouseRole: 'consumer' })).not.toThrow();
  });

  it('createRuntime refuses a consumer connecting as the admin user', async () => {
    const config = prod({ CLICKHOUSE_CONSUMER_USER: 'proba', CLICKHOUSE_CONSUMER_PASSWORD: 'admin-pw' });
    const err = await createRuntime(config, { logger: new MemoryLogger(), clickhouseRole: 'consumer', usesLeases: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClickHouseRoleError);
  });
});
