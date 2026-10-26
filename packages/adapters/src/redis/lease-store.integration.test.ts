import { describe, expect, it } from 'vitest';
import { loadConfig, MemoryLogger } from '@smallseedlabs/proba-audit-core';
import { runLeaseStoreContract, uniqueName } from '@smallseedlabs/proba-audit-core/testing';
import { createClient } from 'redis';
import { RedisLeaseStore } from './lease-store.js';

const config = loadConfig(process.env);
const url = config.eventBus.redisUrl;
const prefix = () => `proba:test:lease:${uniqueName('p')}`;

// "store" and "peer" are two separate connections, as two replicas would have.
runLeaseStoreContract('redis', async () => {
  const keyPrefix = prefix();
  return { store: new RedisLeaseStore({ url, keyPrefix }), peer: new RedisLeaseStore({ url, keyPrefix }) };
});

describe('RedisLeaseStore specifics', () => {
  it('stores the owner id under the prefixed key with a TTL', async () => {
    const keyPrefix = prefix();
    const store = new RedisLeaseStore({ url, keyPrefix });
    const raw = createClient({ url });
    await raw.connect();
    try {
      await store.tryAcquire('k1', 'owner-a', 5000);
      expect(await raw.get(`${keyPrefix}:k1`)).toBe('owner-a');
      const ttl = await raw.pTTL(`${keyPrefix}:k1`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5000);
      await store.release('k1', 'owner-a');
      expect(await raw.exists(`${keyPrefix}:k1`)).toBe(0);
    } finally {
      await raw.quit();
      await store.close();
    }
  });

  it('fails closed: an unreachable Redis throws instead of granting the lease', async () => {
    const store = new RedisLeaseStore({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 300, logger: new MemoryLogger() });
    await expect(store.tryAcquire('k', 'owner-a', 1000)).rejects.toThrow();
    await expect(store.ping()).rejects.toThrow();
    await store.close();
  });
});
