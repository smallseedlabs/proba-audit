import { describe, expect, it } from 'vitest';
import { makeObservation, makeStoredAuditEvent } from '@smallseedlabs/proba-audit-core/testing';
import { buildAuditContent, digestAuditContent } from '@smallseedlabs/proba-audit-core';
import { InMemoryAuditContentStore } from './audit-content-store.js';
import { InMemoryAuditStore } from './audit-store.js';
import { ManualClock, SequentialIdGenerator } from './clock-ids.js';
import { InMemoryEventBus } from './event-bus.js';
import { InMemoryMetricsStore } from './metrics-store.js';

describe('ManualClock', () => {
  it('moves only when told to', () => {
    const clock = new ManualClock('2026-10-25T10:00:00.000Z');
    expect(clock.isoNow()).toBe('2026-10-25T10:00:00.000Z');
    clock.advance(1500);
    expect(clock.isoNow()).toBe('2026-10-25T10:00:01.500Z');
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('SequentialIdGenerator', () => {
  it('is deterministic', () => {
    const ids = new SequentialIdGenerator();
    expect(ids.uuid()).toBe('00000000-0000-4000-8000-000000000001');
    expect(ids.spanId()).toBe('0000000000000001');
  });
});

describe('InMemoryEventBus with a manual clock', () => {
  it('reclaims only after the idle time has passed on the injected clock', async () => {
    const clock = new ManualClock();
    const bus = new InMemoryEventBus(clock);
    const sub = await bus.subscribe({ topic: 't', group: 'g', consumer: 'c' });
    await bus.publish('t', { x: 1 });
    await sub.read();
    expect(await sub.reclaimPending({ minIdleMs: 1000 })).toEqual([]);
    clock.advance(1000);
    expect(await sub.reclaimPending({ minIdleMs: 1000 })).toHaveLength(1);
  });

  it('does not share payload objects with callers', async () => {
    const bus = new InMemoryEventBus();
    const sub = await bus.subscribe({ topic: 't', group: 'g', consumer: 'c' });
    const payload = { a: 1 };
    await bus.publish('t', payload);
    payload.a = 2;
    const [m] = await sub.read<{ a: number }>();
    expect(m.payload.a).toBe(1);
  });
});

describe('InMemory stores copy data', () => {
  it('audit store returns copies', async () => {
    const store = new InMemoryAuditStore();
    const e = makeStoredAuditEvent({ workspaceId: 'w' });
    await store.appendBatch([e]);
    e.details.mutated = true;
    const [got] = await store.query({ workspaceId: 'w' });
    expect(got.details.mutated).toBeUndefined();
  });

  it('metrics store stamps rollups with the injected clock', async () => {
    const clock = new ManualClock('2026-11-01T00:00:00.000Z');
    const store = new InMemoryMetricsStore(clock);
    await store.upsertObservations('ws_1', [makeObservation({ accountId: 'a' })]);
    await store.computeRollups({ workspaceId: 'ws_1', bucket: 'hour', from: '2026-10-25T10:00:00.000Z', to: '2026-10-25T11:00:00.000Z' });
    const [r] = await store.queryRollups({ workspaceId: 'ws_1', bucket: 'hour', accountId: 'a' });
    expect(r.computedAt).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('InMemoryAuditContentStore', () => {
  const content = buildAuditContent('user_message', 'hello');
  const row = (eventId: string, workspaceId = 'seedbed') => ({
    workspaceId,
    eventId,
    occurredAt: '2026-10-25T10:00:00.000Z',
    content,
    contentDigest: digestAuditContent(content),
  });

  it('stores per workspace and event, returns copies, and is idempotent', async () => {
    const store = new InMemoryAuditContentStore();
    await store.put([row('e1'), row('e2'), row('e1')]);
    expect(await store.get('seedbed', 'e1')).toEqual(row('e1'));
    expect(await store.get('other', 'e1')).toBeNull();
    expect((await store.getMany('seedbed', ['e1', 'e2', 'e3', 'e1'])).map((r) => r.eventId).sort()).toEqual(['e1', 'e2']);
    const copy = await store.get('seedbed', 'e1');
    copy!.content.text = 'changed';
    expect((await store.get('seedbed', 'e1'))!.content.text).toBe('hello');
  });
});
