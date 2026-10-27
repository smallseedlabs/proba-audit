import { describe, expect, it } from 'vitest';
import { loadConfig } from '@smallseedlabs/proba-audit-core';
import { runEventBusContract, uniqueName } from '@smallseedlabs/proba-audit-core/testing';
import { createClient } from 'redis';
import { RedisStreamsEventBus } from './redis-streams-event-bus.js';

const config = loadConfig(process.env);

runEventBusContract('redis-streams', async () => ({
  bus: new RedisStreamsEventBus({ url: config.eventBus.redisUrl }),
}));

describe('RedisStreamsEventBus specifics', () => {
  it('stores messages as stream entries with the dead-letter stream named <topic>.dlq', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const raw = createClient({ url: config.eventBus.redisUrl });
    await raw.connect();
    try {
      const topic = uniqueName('raw');
      const sub = await bus.subscribe({ topic, group: 'g', consumer: 'c' });
      await bus.publish(topic, { a: 1 }, { key: 'k1' });
      const [m] = await sub.read({ blockMs: 500 });
      await sub.deadLetter([m], 'because');
      expect(await raw.xLen(topic)).toBe(1);
      expect(await raw.xLen(`${topic}.dlq`)).toBe(1);
      expect(m.key).toBe('k1');
    } finally {
      await raw.quit();
      await bus.close();
    }
  });

  it('publishing never trims: a long unread stream keeps every message', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const raw = createClient({ url: config.eventBus.redisUrl });
    await raw.connect();
    try {
      const topic = uniqueName('notrim');
      await bus.publishBatch(topic, Array.from({ length: 50 }, (_, i) => ({ i })));
      expect(await raw.xLen(topic)).toBe(50);
    } finally {
      await raw.quit();
      await bus.close();
    }
  });

  it('trimAcknowledged: XTRIM never passes the oldest pending id of ANY group (checked against the raw stream)', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const raw = createClient({ url: config.eventBus.redisUrl });
    await raw.connect();
    try {
      const topic = uniqueName('safe');
      const a = await bus.subscribe({ topic, group: 'a', consumer: 'c' });
      const b = await bus.subscribe({ topic, group: 'b', consumer: 'c' });
      const ids = await bus.publishBatch(topic, Array.from({ length: 10 }, (_, i) => ({ i })));
      const readA = await a.read({ max: 10, blockMs: 500 });
      await a.ack(readA.map((m) => m.id)); // a: everything acknowledged
      const readB = await b.read({ max: 6, blockMs: 500 }); // b: read 6 of 10
      await b.ack([readB[0].id, readB[1].id, readB[3].id]); // b: acked 0, 1, 3; 2, 4, 5 pending; 6..9 undelivered
      await new Promise((r) => setTimeout(r, 10));

      expect(await bus.trimAcknowledged(topic, { maxAgeMs: 0 })).toBe(2); // only ids before b's oldest pending (index 2)
      const left = (await raw.xRange(topic, '-', '+')).map((e) => e.id);
      expect(left).toEqual(ids.slice(2));
      expect(await raw.xLen(topic)).toBe(8);

      // Everything pending for b is still there to be reclaimed, and the undelivered tail is still readable.
      const reclaimed = await b.reclaimPending({ minIdleMs: 0 });
      expect(reclaimed.map((m) => m.id)).toEqual([readB[2].id, readB[4].id, readB[5].id]);
      expect((await b.read({ max: 10, blockMs: 500 })).map((m) => m.id)).toEqual(ids.slice(6));
    } finally {
      await raw.quit();
      await bus.close();
    }
  });

  it('trimAcknowledged: a group that never read blocks the trim', async () => {
    const bus = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const raw = createClient({ url: config.eventBus.redisUrl });
    await raw.connect();
    try {
      const topic = uniqueName('idlegroup');
      const a = await bus.subscribe({ topic, group: 'a', consumer: 'c' });
      await bus.subscribe({ topic, group: 'idle', consumer: 'c' });
      await bus.publishBatch(topic, [{ i: 0 }, { i: 1 }]);
      await a.ack((await a.read({ blockMs: 500 })).map((m) => m.id));
      await new Promise((r) => setTimeout(r, 10));
      expect(await bus.trimAcknowledged(topic, { maxAgeMs: 0 })).toBe(0);
      expect(await raw.xLen(topic)).toBe(2);
    } finally {
      await raw.quit();
      await bus.close();
    }
  });

  it('re-delivers to a second consumer after the first stops without acking (crash recovery)', async () => {
    const bus1 = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    const bus2 = new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
    try {
      const topic = uniqueName('crash');
      const s1 = await bus1.subscribe({ topic, group: 'g', consumer: 'worker-1' });
      await bus1.publish(topic, { job: 1 });
      expect(await s1.read({ blockMs: 500 })).toHaveLength(1);
      await bus1.close(); // "crash": never acked

      const s2 = await bus2.subscribe({ topic, group: 'g', consumer: 'worker-2' });
      await new Promise((r) => setTimeout(r, 20));
      const retried = await s2.reclaimPending({ minIdleMs: 10 });
      expect(retried).toHaveLength(1);
      expect(retried[0].deliveryCount).toBe(2);
    } finally {
      await bus2.close();
    }
  });

  it('throws from ping when Redis is unreachable', async () => {
    const bus = new RedisStreamsEventBus({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 500 });
    await expect(bus.ping()).rejects.toThrow();
    await bus.close();
  });
});
