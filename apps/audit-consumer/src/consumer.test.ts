import { afterEach, describe, expect, it } from 'vitest';
import {
  LeaseHeldError,
  chainEvent,
  verifyChain,
  type AuditEvent,
  type StoredAuditEvent,
} from '@smallseedlabs/proba-audit-core';
import {
  InMemoryAnchorStore,
  InMemoryLeaseStore,
  InMemoryAuditStore,
  InMemoryEventBus,
  ManualClock,
  SequentialIdGenerator,
} from '@smallseedlabs/proba-audit-adapters';
import { ConsumerHarness, makeEvent, type HarnessOptions } from './harness.testing.js';

const TOPIC = 'audit';
const GROUP = 'audit-consumer';

interface Setup {
  h: ConsumerHarness;
  bus: InMemoryEventBus;
  store: InMemoryAuditStore;
  clock: ManualClock;
}

const open: ConsumerHarness[] = [];
function setup(options: Partial<HarnessOptions> = {}): Setup {
  const bus = options.bus ?? new InMemoryEventBus();
  const store = options.store ?? new InMemoryAuditStore();
  const clock = new ManualClock('2026-10-25T10:05:00.000Z');
  const h = new ConsumerHarness({
    bus,
    store,
    clock,
    ids: new SequentialIdGenerator(),
    topic: TOPIC,
    group: GROUP,
    selfAudit: false,
    ...options,
  });
  open.push(h);
  return { h, bus: bus as InMemoryEventBus, store: store as InMemoryAuditStore, clock };
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const stored = (store: InMemoryAuditStore, workspaceId: string) => store.readChain(workspaceId);

describe('AuditConsumer: processing', () => {
  it('validates, derives tags, chains and writes, then acknowledges', async () => {
    const { h, store } = setup();
    const e1 = makeEvent({ riskLevel: 'high', tags: ['mine'] });
    const e2 = makeEvent({ outcome: 'failure' });
    await h.publish(e1, e2);
    const { result } = await h.pump();

    expect(result).toMatchObject({ received: 2, written: 2, duplicates: 0, invalid: 0, conflicts: 0, workspaces: ['seedbed'] });
    const [a, b] = await stored(store, 'seedbed');
    expect(a).toMatchObject({ eventId: e1.eventId, prevHash: null, schemaVersion: 1 });
    expect(a?.tags).toEqual(['mine', 'category:command', 'outcome:success', 'service:hub', 'risk:high']);
    expect(b?.tags).toEqual(['category:command', 'outcome:failure', 'service:hub']);
    expect(b?.prevHash).toBe(a?.hash);
    expect(a?.ingestedAt).toBe('2026-10-25T10:05:00.000Z');
    expect(b?.ingestedAt).toBe('2026-10-25T10:05:00.001Z'); // strictly increasing within the chain
    expect(await h.pending()).toBe(0);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 2 });
  });

  it('continues the chain across batches from the cached head', async () => {
    const { h, store, clock } = setup();
    await h.publish(makeEvent(), makeEvent());
    await h.pump();
    clock.advance(1000);
    await h.publish(makeEvent(), makeEvent(), makeEvent());
    await h.pump();
    expect(await verifyChain(store, 'seedbed', {}, { pageSize: 2 })).toMatchObject({ ok: true, checked: 5 });
    // The head was read from the store once, then served from the cache.
    expect(h.logger.records.filter((r) => r.msg === 'chain head recovered from store')).toHaveLength(1);
    expect(h.consumer.cachedHead('seedbed')?.hash).toBe((await stored(store, 'seedbed')).at(-1)?.hash);
  });

  it('keeps one independent chain per workspace, even when interleaved in one batch', async () => {
    const { h, store } = setup();
    await h.publish(
      makeEvent({ workspaceId: 'ws-a' }),
      makeEvent({ workspaceId: 'ws-b' }),
      makeEvent({ workspaceId: 'ws-a' }),
      makeEvent({ workspaceId: 'ws-b' }),
      makeEvent({ workspaceId: 'ws-a' })
    );
    const { result } = await h.pump();
    expect([...result.workspaces].sort()).toEqual(['ws-a', 'ws-b']);
    const a = await stored(store, 'ws-a');
    const b = await stored(store, 'ws-b');
    expect([a.length, b.length]).toEqual([3, 2]);
    expect(a[0]?.prevHash).toBeNull();
    expect(b[0]?.prevHash).toBeNull(); // genesis of its own chain, not linked to ws-a
    expect(await verifyChain(store, 'ws-a')).toMatchObject({ ok: true, checked: 3 });
    expect(await verifyChain(store, 'ws-b')).toMatchObject({ ok: true, checked: 2 });
  });

  it('recovers the chain head from the store after a restart', async () => {
    const bus = new InMemoryEventBus();
    const store = new InMemoryAuditStore();
    const first = setup({ bus, store });
    await first.h.publish(makeEvent(), makeEvent());
    await first.h.pump();
    await first.h.close();

    const second = setup({ bus, store, consumerName: 'consumer-2' });
    expect(second.h.consumer.cachedHead('seedbed')).toBeUndefined();
    await second.h.publish(makeEvent());
    await second.h.pump();
    const recovered = second.h.logger.records.find((r) => r.msg === 'chain head recovered from store');
    expect(recovered?.fields).toMatchObject({ workspaceId: 'seedbed', headHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 3 });
  });

  it('starts a fresh chain for a workspace that has no events yet', async () => {
    const { h, store } = setup();
    await h.publish(makeEvent({ workspaceId: 'brand-new' }));
    await h.pump();
    expect((await stored(store, 'brand-new'))[0]?.prevHash).toBeNull();
  });
});

describe('AuditConsumer: duplicates', () => {
  it('skips an identical redelivery without a gap in the chain', async () => {
    const { h, store } = setup();
    const e = makeEvent();
    await h.publish(makeEvent(), e);
    await h.pump();
    await h.publish(e, makeEvent()); // e is redelivered, in front of a new event
    const { result } = await h.pump();
    expect(result).toMatchObject({ written: 1, duplicates: 1, conflicts: 0 });
    expect(await stored(store, 'seedbed')).toHaveLength(3);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 3 });
    expect(await h.pending()).toBe(0);
    expect(h.errors()).toEqual([]);
  });

  it('skips an identical duplicate inside one batch', async () => {
    const { h, store } = setup();
    const e = makeEvent();
    await h.publish(e, e, makeEvent());
    const { result } = await h.pump();
    expect(result).toMatchObject({ received: 3, written: 2, duplicates: 1 });
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 2 });
    expect(await h.pending()).toBe(0);
  });

  it('treats a redelivery with reordered keys as identical', async () => {
    const { h, store } = setup();
    const e = makeEvent({ details: { a: 1, b: { x: 1, y: 2 } } });
    await h.publish(e);
    await h.pump();
    await h.publish({ ...e, details: { b: { y: 2, x: 1 }, a: 1 } });
    expect((await h.pump()).result).toMatchObject({ written: 0, duplicates: 1, conflicts: 0 });
    expect(await stored(store, 'seedbed')).toHaveLength(1);
  });

  it('does not write an eventId with different content: dead-letters it with a reason and logs an error', async () => {
    const { h, store, bus } = setup();
    const original = makeEvent({ action: 'command.received' });
    await h.publish(original);
    await h.pump();
    const stored1 = (await stored(store, 'seedbed'))[0] as StoredAuditEvent;

    const clash = { ...original, action: 'command.rejected', outcome: 'denied' as const };
    await h.publish(clash, makeEvent());
    const { result } = await h.pump();

    expect(result).toMatchObject({ written: 1, conflicts: 1, duplicates: 0 });
    const all = await stored(store, 'seedbed');
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.eventId === original.eventId)).toEqual(stored1); // untouched
    const dead = await bus.listDeadLetters(TOPIC);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toContain(original.eventId);
    expect(dead[0]?.reason).toContain('different content');
    expect(dead[0]?.payload).toEqual(clash);
    const error = h.errors().find((r) => r.msg.includes('conflicting audit event'));
    expect(error?.fields).toMatchObject({ eventId: original.eventId, traceId: original.traceId });
    expect(await h.pending()).toBe(0);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 2 });
  });

  it('dead-letters a conflict between two events with the same id in one batch (first wins)', async () => {
    const { h, store, bus } = setup();
    const a = makeEvent({ action: 'command.received' });
    await h.publish(a, { ...a, action: 'command.rejected' });
    const { result } = await h.pump();
    expect(result).toMatchObject({ written: 1, conflicts: 1 });
    expect((await stored(store, 'seedbed'))[0]?.action).toBe('command.received');
    expect((await bus.listDeadLetters(TOPIC))[0]?.reason).toContain('earlier in the same batch');
  });
});

describe('AuditConsumer: invalid events (DLQ)', () => {
  it('dead-letters invalid payloads with a reason, writes the valid ones, and logs the traceId when present', async () => {
    const { h, store, bus } = setup();
    const good = makeEvent();
    const traceId = '99999999-9999-4999-8999-999999999999';
    await h.publish({ ...makeEvent({ traceId }), action: 'Bad Action' }, 'not an object', good, { hello: 'world' });
    const { result } = await h.pump();
    expect(result).toMatchObject({ received: 4, written: 1, invalid: 3 });
    expect(await stored(store, 'seedbed')).toHaveLength(1);
    const dead = await bus.listDeadLetters(TOPIC);
    expect(dead).toHaveLength(3);
    expect(dead.every((d) => d.reason.startsWith('invalid audit event:'))).toBe(true);
    expect(dead.find((d) => d.reason.includes('action'))).toBeDefined();
    const logged = h.errors().find((r) => r.fields.traceId === traceId);
    expect(logged?.msg).toBe('invalid audit event, dead-lettering');
    expect(await h.pending()).toBe(0);
  });

  it('does not accept producer-supplied chain fields: they are stripped, never trusted', async () => {
    const { h, store } = setup();
    await h.publish({ ...makeEvent(), prevHash: 'f'.repeat(64), hash: 'e'.repeat(64), ingestedAt: '2000-01-01T00:00:00.000Z' });
    await h.pump();
    const [e] = await stored(store, 'seedbed');
    expect(e?.prevHash).toBeNull();
    expect(e?.hash).not.toBe('e'.repeat(64));
    expect(e?.ingestedAt).toBe('2026-10-25T10:05:00.000Z');
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true });
  });
});

describe('AuditConsumer: durability and crash recovery', () => {
  it('acknowledges nothing when the store write fails, and succeeds on retry with an intact chain', async () => {
    const { h, store } = setup();
    await h.publish(makeEvent(), makeEvent(), makeEvent());
    const messages = await h.read();
    const append = store.appendBatch.bind(store);
    store.appendBatch = () => Promise.reject(new Error('clickhouse down'));
    await expect(h.consumer.processBatch(messages)).rejects.toThrow('clickhouse down');
    expect(await h.pending()).toBe(3); // nothing acked
    expect(await stored(store, 'seedbed')).toHaveLength(0);
    expect(h.consumer.cachedHead('seedbed')).toBeUndefined(); // no speculative head cached

    store.appendBatch = append;
    expect((await h.consumer.processBatch(messages)).written).toBe(3);
    expect(await h.pending()).toBe(0);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 3 });
  });

  it('survives a crash between the durable write and the ack: the redelivery is recognised as a duplicate', async () => {
    const bus = new InMemoryEventBus();
    const store = new InMemoryAuditStore();
    const crashing = setup({ bus, store });
    await crashing.h.publish(makeEvent(), makeEvent());
    const messages = await crashing.h.read();
    const sub = await crashing.h.consumer.attach();
    sub.ack = () => Promise.reject(new Error('process killed before XACK'));
    await expect(crashing.h.consumer.processBatch(messages)).rejects.toThrow('killed');
    expect(await stored(store, 'seedbed')).toHaveLength(2); // the write was durable
    expect(await sub.pendingCount()).toBe(2); // but never acknowledged

    // New process: same group, reclaims the pending messages and processes them again.
    const restarted = setup({ bus, store, consumerName: 'consumer-2', overrides: { claimIdleMs: 0 } });
    const reclaimSub = await restarted.h.consumer.attach();
    const redelivered = await reclaimSub.reclaimPending({ minIdleMs: 0 });
    expect(redelivered.map((m) => m.deliveryCount)).toEqual([2, 2]);
    const result = await restarted.h.consumer.processBatch(redelivered);
    expect(result).toMatchObject({ written: 0, duplicates: 2, conflicts: 0 });
    expect(await reclaimSub.pendingCount()).toBe(0);
    expect(await stored(store, 'seedbed')).toHaveLength(2);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 2 });
  });

  it('recovers messages left pending by a dead consumer through the reclaim loop', async () => {
    const bus = new InMemoryEventBus();
    const store = new InMemoryAuditStore();
    const dead = setup({ bus, store, consumerName: 'dead-consumer' });
    await dead.h.publish(makeEvent(), makeEvent(), makeEvent());
    expect(await dead.h.read()).toHaveLength(3); // delivered to a consumer that then "crashes"

    const live = setup({
      bus,
      store,
      consumerName: 'live-consumer',
      overrides: { claimIdleMs: 20, reclaimIntervalMs: 20, blockMs: 20 },
    });
    await new Promise((r) => setTimeout(r, 40)); // let the messages go idle
    await live.h.consumer.start();
    await waitFor(async () => (await stored(store, 'seedbed')).length === 3);
    expect(await live.h.pending()).toBe(0);
    expect(live.h.logger.records.some((r) => r.msg === 'reclaimed pending messages')).toBe(true);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 3 });
  });

  it('keeps retrying a failing batch with backoff without reading more or counting redeliveries', async () => {
    const { h, store, bus } = setup({ overrides: { retryBaseMs: 5, retryMaxMs: 10 } });
    const append = store.appendBatch.bind(store);
    let failures = 3;
    store.appendBatch = (events) => (failures-- > 0 ? Promise.reject(new Error('store down')) : append(events));
    await h.publish(makeEvent(), makeEvent());
    await h.consumer.start();
    await waitFor(async () => (await stored(store, 'seedbed')).length === 2);
    expect(h.errors().filter((r) => r.msg.startsWith('batch failed'))).toHaveLength(3);
    expect(await h.pending()).toBe(0);
    expect(await bus.listDeadLetters(TOPIC)).toEqual([]);
    expect(await verifyChain(store, 'seedbed')).toMatchObject({ ok: true, checked: 2 });
  });

  it('shuts down gracefully: finishes the batch in flight, stops reading, closes the subscription', async () => {
    const { h, store } = setup();
    await h.consumer.start();
    await h.publish(makeEvent());
    await waitFor(async () => (await stored(store, 'seedbed')).length === 1);
    await h.consumer.stop();
    expect(h.logger.records.some((r) => r.msg === 'audit consumer stopped')).toBe(true);
    await h.publish(makeEvent());
    await new Promise((r) => setTimeout(r, 120));
    expect(await stored(store, 'seedbed')).toHaveLength(1); // nothing read after stop
    await h.consumer.stop(); // idempotent
  });
});

describe('AuditConsumer: self-audit', () => {
  it('emits one batch event per workspace through the same bus, in a trace of its own', async () => {
    const { h, store } = setup({ selfAudit: true });
    await h.publish(makeEvent({ workspaceId: 'ws-a' }), makeEvent({ workspaceId: 'ws-a' }), makeEvent({ workspaceId: 'ws-b' }));
    await h.pump();
    const messages = await h.read();
    const emitted = messages.map((m) => m.payload as AuditEvent);
    expect(emitted.map((e) => [e.action, e.workspaceId, e.service, e.outcome])).toEqual([
      ['system.audit_batch_processed', 'ws-a', 'audit-consumer', 'success'],
      ['system.audit_batch_processed', 'ws-b', 'audit-consumer', 'success'],
    ]);
    expect(emitted[0]?.details).toMatchObject({ written: 2, deadLettered: 0 });
    expect(emitted[0]?.traceId).toBe(emitted[1]?.traceId);

    // They come back through the consumer and are stored and chained like any event.
    const result = await h.consumer.processBatch(messages);
    expect(result).toMatchObject({ received: 2, written: 2 });
    expect(await verifyChain(store, 'ws-a')).toMatchObject({ ok: true, checked: 3 });
  });

  it('does not feed back: a batch of only its own events produces no further events', async () => {
    const { h } = setup({ selfAudit: true });
    await h.publish(makeEvent());
    await h.pump(); // user event -> emits one batch event
    await h.pump(); // that batch event -> processed, must emit nothing
    expect(await h.read()).toEqual([]);
    expect(await h.pending()).toBe(0);
  });

  it('reports a dead letter as an event inside the trace of the offending event', async () => {
    const { h, bus } = setup({ selfAudit: true });
    const original = makeEvent();
    await h.publish(original);
    await h.pump();
    await h.read(); // discard the batch event
    await h.publish({ ...original, action: 'command.rejected' }, { nonsense: true });
    await h.pump();
    const emitted = (await h.read()).map((m) => m.payload as AuditEvent).filter((e) => e.action === 'system.audit_event_dead_lettered');
    expect(emitted).toHaveLength(2);
    const conflict = emitted.find((e) => e.errorCode === 'conflict');
    expect(conflict).toMatchObject({
      traceId: original.traceId,
      workspaceId: 'seedbed',
      outcome: 'failure',
      riskLevel: 'high',
      target: { type: 'audit_event', id: original.eventId },
    });
    const invalid = emitted.find((e) => e.errorCode === 'invalid_event');
    expect(invalid).toMatchObject({ riskLevel: 'medium', target: { type: 'bus_message' } });
    expect(invalid?.details.issues).toBeDefined();
    expect(await bus.listDeadLetters(TOPIC)).toHaveLength(2);
  });

  it('never fails the batch when self-audit fails', async () => {
    const { h, bus, store } = setup({ selfAudit: true });
    const publish = bus.publish.bind(bus);
    bus.publish = () => Promise.reject(new Error('bus hiccup'));
    await h.publish(makeEvent()).catch(() => undefined);
    bus.publish = publish;
    await h.publish(makeEvent());
    bus.publish = () => Promise.reject(new Error('bus hiccup'));
    const { result } = await h.pump();
    expect(result.written).toBeGreaterThan(0);
    expect(await store.readChain('seedbed')).not.toHaveLength(0);
    expect(h.errors().some((r) => r.msg === 'audit event not emitted')).toBe(true);
  });
});

describe('AuditConsumer: chain anchors', () => {
  const KEY = 'consumer-anchor-key-0123456789-0123456789';
  const anchorStore = () => new InMemoryAnchorStore({ hmacKey: KEY });

  it('anchors the new head and the chain length of every workspace after a durable write', async () => {
    const anchors = anchorStore();
    const { h, store } = setup({ anchors });
    await h.publish(makeEvent(), makeEvent(), makeEvent({ workspaceId: 'other' }));
    await h.pump();
    const [a, b] = await stored(store, 'seedbed');
    expect(await anchors.get('seedbed')).toMatchObject({ headHash: b?.hash, count: 2, timestamp: b?.ingestedAt });
    expect(await anchors.get('other')).toMatchObject({ count: 1 });
    expect(a).toBeDefined();
    expect(await verifyChain(store, 'seedbed', {}, { anchorStore: anchors })).toMatchObject({ ok: true, anchor: { checked: true, count: 2 } });
  });

  it('moves the anchor forward with every batch, counting the store once', async () => {
    const anchors = anchorStore();
    const { h, store, clock } = setup({ anchors });
    const countEvents = store.countEvents.bind(store);
    let counted = 0;
    store.countEvents = (ws) => {
      counted += 1;
      return countEvents(ws);
    };
    await h.publish(makeEvent(), makeEvent());
    await h.pump();
    clock.advance(1000);
    await h.publish(makeEvent(), makeEvent(), makeEvent());
    await h.pump();
    const last = (await stored(store, 'seedbed')).at(-1);
    expect(await anchors.get('seedbed')).toMatchObject({ count: 5, headHash: last?.hash });
    expect(counted).toBe(1);
  });

  it('a restarted consumer anchors from the live chain', async () => {
    const anchors = anchorStore();
    const first = setup({ anchors });
    await first.h.publish(makeEvent(), makeEvent());
    await first.h.pump();
    const second = setup({ anchors, store: first.store, bus: first.bus, overrides: { consumerName: 'consumer-2' } });
    await second.h.publish(makeEvent());
    await second.h.pump();
    expect(await anchors.get('seedbed')).toMatchObject({ count: 3 });
  });

  it('makes deleting the newest events detectable', async () => {
    const anchors = anchorStore();
    const { h, store } = setup({ anchors });
    await h.publish(makeEvent(), makeEvent(), makeEvent(), makeEvent());
    await h.pump();
    const shorter = new InMemoryAuditStore();
    await shorter.appendBatch((await stored(store, 'seedbed')).slice(0, 2));
    expect(await verifyChain(shorter, 'seedbed')).toMatchObject({ ok: true }); // a valid, shorter chain
    const result = await verifyChain(shorter, 'seedbed', {}, { anchorStore: anchors });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.type)).toContain('tail_truncated');
  });

  it('does not touch the anchor for a redelivered duplicate', async () => {
    const anchors = anchorStore();
    const { h } = setup({ anchors });
    const e = makeEvent();
    await h.publish(e);
    await h.pump();
    const before = await anchors.get('seedbed');
    await h.publish(e);
    await h.pump();
    expect(await anchors.get('seedbed')).toEqual(before);
  });

  it('keeps ingesting when the anchor store is down, and anchors the newest head with the next batch', async () => {
    const anchors = anchorStore();
    const { h, store, clock } = setup({ anchors });
    const put = anchors.put.bind(anchors);
    anchors.put = () => Promise.reject(new Error('anchor store down'));
    await h.publish(makeEvent(), makeEvent());
    const { result } = await h.pump();
    expect(result.written).toBe(2);
    expect(await h.pending()).toBe(0);
    expect(h.errors().some((r) => r.msg === 'chain anchor not stored; will retry with the next batch')).toBe(true);
    expect(await anchors.get('seedbed')).toBeNull();

    anchors.put = put;
    clock.advance(1000);
    await h.publish(makeEvent());
    await h.pump();
    const last = (await stored(store, 'seedbed')).at(-1);
    expect(await anchors.get('seedbed')).toMatchObject({ count: 3, headHash: last?.hash });
  });

  it('logs an integrity error when the anchor is ahead of the chain', async () => {
    const anchors = anchorStore();
    await anchors.put({ workspaceId: 'seedbed', headHash: 'f'.repeat(64), count: 50, timestamp: '2026-10-25T09:00:00.000Z' });
    const { h } = setup({ anchors });
    await h.publish(makeEvent());
    await h.pump();
    expect(h.errors().some((r) => r.msg.startsWith('chain integrity risk: the anchor is ahead of the chain'))).toBe(true);
    expect((await anchors.get('seedbed'))?.count).toBe(50); // never goes backwards
  });

  it('works without an anchor store', async () => {
    const { h } = setup();
    await h.publish(makeEvent());
    expect((await h.pump()).result.written).toBe(1);
  });
});

describe('AuditConsumer: workspace write leases (several instances)', () => {
  const second = (first: Setup, leases: InMemoryLeaseStore, anchors?: InMemoryAnchorStore) =>
    setup({ bus: first.bus, store: first.store, leases, ...(anchors ? { anchors } : {}), consumerName: 'consumer-2' });

  it('two instances alternating on one workspace keep one valid chain (heads are re-read under the lease)', async () => {
    const leases = new InMemoryLeaseStore();
    const anchors = new InMemoryAnchorStore({ hmacKey: 'lease-test-anchor-key-0123456789-0123456789' });
    const a = setup({ leases, anchors, consumerName: 'consumer-1' });
    const b = second(a, leases, anchors);
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(5);
      b.clock.advance(5);
      await a.h.publish(makeEvent(), makeEvent());
      await a.h.pump();
      await a.h.publish(makeEvent());
      await b.h.pump();
    }
    expect(await verifyChain(a.store, 'seedbed', {}, { anchorStore: anchors, pageSize: 2 })).toMatchObject({ ok: true, checked: 9, anchor: { checked: true, count: 9 } });
  });

  it('without leases a second writer breaks the chain (what the lease prevents)', async () => {
    const a = setup({ consumerName: 'consumer-1' });
    const b = setup({ bus: a.bus, store: a.store, consumerName: 'consumer-2' });
    await a.h.publish(makeEvent());
    await a.h.pump();
    await a.h.publish(makeEvent());
    await b.h.pump();
    await a.h.publish(makeEvent());
    await a.h.pump(); // a still trusts the head it cached before b wrote
    expect((await verifyChain(a.store, 'seedbed')).ok).toBe(false);
  });

  it('a workspace leased by another instance fails the batch, acknowledges nothing, and succeeds once it is free', async () => {
    const leases = new InMemoryLeaseStore();
    const a = setup({ leases, consumerName: 'consumer-1' });
    await leases.tryAcquire('audit-consumer:workspace:seedbed', 'consumer-2', 60_000);
    await a.h.publish(makeEvent());
    const messages = await a.h.read();
    await expect(a.h.consumer.processBatch(messages)).rejects.toBeInstanceOf(LeaseHeldError);
    expect(await stored(a.store, 'seedbed')).toHaveLength(0);
    expect(await a.h.pending()).toBe(1);
    await leases.release('audit-consumer:workspace:seedbed', 'consumer-2');
    expect(await a.h.consumer.processBatch(messages)).toMatchObject({ written: 1 });
    expect(await a.h.pending()).toBe(0);
  });

  it('takes all leases or none, and releases them after the batch (also a failed one)', async () => {
    const leases = new InMemoryLeaseStore();
    const a = setup({ leases, consumerName: 'consumer-1' });
    await leases.tryAcquire('audit-consumer:workspace:zeta', 'consumer-2', 60_000);
    await a.h.publish(makeEvent({ workspaceId: 'alpha' }), makeEvent({ workspaceId: 'zeta' }));
    const messages = await a.h.read();
    await expect(a.h.consumer.processBatch(messages)).rejects.toBeInstanceOf(LeaseHeldError);
    expect(await leases.tryAcquire('audit-consumer:workspace:alpha', 'probe', 1000)).toBe(true); // alpha was given back
    await leases.release('audit-consumer:workspace:alpha', 'probe');
    await leases.release('audit-consumer:workspace:zeta', 'consumer-2');

    a.store.appendBatch = () => Promise.reject(new Error('store down'));
    await expect(a.h.consumer.processBatch(messages)).rejects.toThrow('store down');
    expect(await leases.tryAcquire('audit-consumer:workspace:alpha', 'probe', 1000)).toBe(true); // released after the failure
  });

  it('writes nothing when a lease was lost during the batch (renewal fails just before the write)', async () => {
    const leases = new InMemoryLeaseStore();
    const a = setup({ leases, consumerName: 'consumer-1' });
    leases.renew = async () => false;
    await a.h.publish(makeEvent());
    const messages = await a.h.read();
    await expect(a.h.consumer.processBatch(messages)).rejects.toThrow(/lost/);
    expect(await stored(a.store, 'seedbed')).toHaveLength(0);
  });

  it('keeps ingesting through the retry loop while another instance holds the lease', async () => {
    const leases = new InMemoryLeaseStore();
    const a = setup({ leases, consumerName: 'consumer-1' });
    await leases.tryAcquire('audit-consumer:workspace:seedbed', 'consumer-2', 60_000);
    await a.h.publish(makeEvent(), makeEvent());
    await a.h.consumer.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(await stored(a.store, 'seedbed')).toHaveLength(0);
    expect(a.h.errors().some((r) => r.msg === 'batch failed, nothing acknowledged; retrying')).toBe(true);
    await leases.release('audit-consumer:workspace:seedbed', 'consumer-2');
    await waitFor(async () => (await stored(a.store, 'seedbed')).length === 2);
    expect(await verifyChain(a.store, 'seedbed')).toMatchObject({ ok: true, checked: 2 });
  });
});

describe('AuditConsumer: stream trimming', () => {
  const trimming = { streamMaxAgeMs: 0, trimIntervalMs: 20 };

  it('trimStream removes what the group acknowledged and never what it has not read yet', async () => {
    const { h } = setup({ overrides: trimming });
    await h.publish(makeEvent(), makeEvent());
    await h.pump(); // both written and acknowledged
    await h.publish(makeEvent()); // published, not read yet
    await new Promise((r) => setTimeout(r, 5));
    expect(await h.consumer.trimStream()).toBe(2);
    expect(await h.consumer.trimStream()).toBe(0);
    const { result } = await h.pump();
    expect(result.written).toBe(1);
  });

  it('the running loop trims on its interval and keeps ingesting', async () => {
    const { h, store } = setup({ overrides: trimming });
    await h.publish(makeEvent(), makeEvent());
    await h.consumer.start();
    await waitFor(async () => (await stored(store, 'seedbed')).length === 2);
    await waitFor(async () => h.logger.records.some((r) => r.fields.lifecycle === 'stream_trimmed'));
    await h.publish(makeEvent());
    await waitFor(async () => (await stored(store, 'seedbed')).length === 3);
  });

  it('a failing trim is logged and does not stop ingestion', async () => {
    const bus = new InMemoryEventBus();
    bus.trimAcknowledged = async () => {
      throw new Error('redis away');
    };
    const { h, store } = setup({ bus, overrides: trimming });
    await h.consumer.start();
    await h.publish(makeEvent());
    await waitFor(async () => (await stored(store, 'seedbed')).length === 1);
    await waitFor(async () => h.logger.records.some((r) => r.fields.lifecycle === 'stream_trim_failed'));
    await h.publish(makeEvent());
    await waitFor(async () => (await stored(store, 'seedbed')).length === 2);
  });
});

describe('chain compatibility', () => {
  it('produces the same chain as chainEvent applied by hand', async () => {
    const { h, store } = setup();
    const e = makeEvent();
    await h.publish(e);
    await h.pump();
    const [got] = await stored(store, 'seedbed');
    expect(got).toEqual(chainEvent(e, null, '2026-10-25T10:05:00.000Z'));
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}
