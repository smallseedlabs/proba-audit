import { describe, expect, it } from 'vitest';
import {
  AuditValidationError,
  AuditedReader,
  MemoryLogger,
  OutboxRelay,
  chainEvent,
  createBusAuditEmitter,
  createOutboxAuditEmitter,
  verifyChain,
  type AuditEvent,
  type ChainLink,
  type StoredAuditEvent,
} from '@smallseedlabs/proba-audit-core';
import { InMemoryAnchorStore } from './anchor-store.js';
import { InMemoryAuditStore } from './audit-store.js';
import { ManualClock, SequentialIdGenerator } from './clock-ids.js';
import { InMemoryEventBus } from './event-bus.js';
import { InMemoryOutboxStore } from './outbox-store.js';

const draft = { actor: { type: 'user' as const, id: 'u1' }, action: 'command.received', category: 'command' as const, outcome: 'success' as const };

function emitterDeps(extra: { failureMode?: 'throw' | 'swallow' } = {}) {
  return {
    service: 'hub',
    defaultWorkspaceId: 'seedbed',
    clock: new ManualClock(),
    ids: new SequentialIdGenerator(),
    logger: new MemoryLogger(),
    ...extra,
  };
}

describe('AuditEmitter (bus)', () => {
  it('builds, validates and publishes an event with defaults filled in', async () => {
    const bus = new InMemoryEventBus();
    const deps = emitterDeps();
    const emitter = createBusAuditEmitter({ ...deps, bus, topic: 'audit' });
    const sent = await emitter.emit({ ...draft, details: { n: 1 } });
    expect(sent).toMatchObject({
      version: 1,
      service: 'hub',
      workspaceId: 'seedbed',
      eventId: '00000000-0000-4000-8000-000000000002',
      traceId: '00000000-0000-4000-8000-000000000001',
      spanId: '0000000000000001',
      occurredAt: '2026-10-25T10:00:00.000Z',
      details: { n: 1 },
    });
    expect(sent).not.toHaveProperty('parentSpanId');
    const sub = await bus.subscribe({ topic: 'audit', group: 'g', consumer: 'c' });
    const [message] = await sub.read();
    expect(message?.payload).toEqual(sent);
    expect(message?.key).toBe('seedbed');
  });

  it('forTrace stamps traceId and parentSpanId, explicit values win', async () => {
    const bus = new InMemoryEventBus();
    const emitter = createBusAuditEmitter({ ...emitterDeps(), bus, topic: 'audit' });
    const traced = emitter.forTrace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
    const a = await traced.emit(draft);
    const b = await traced.emit({ ...draft, traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspaceId: 'ws2', service: 'brain' });
    expect(a).toMatchObject({ traceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', parentSpanId: 'bbbbbbbbbbbbbbbb' });
    expect(b).toMatchObject({ traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspaceId: 'ws2', service: 'brain' });
  });

  it('rejects an invalid event with the validation issues and publishes nothing', async () => {
    const bus = new InMemoryEventBus();
    const deps = emitterDeps();
    const emitter = createBusAuditEmitter({ ...deps, bus, topic: 'audit' });
    const err = await emitter.emit({ ...draft, action: 'Not A Valid Action' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditValidationError);
    expect((err as AuditValidationError).issues[0]?.path).toBe('action');
    expect(deps.logger.records.some((r) => r.level === 'error' && r.msg === 'audit event not emitted')).toBe(true);
    const sub = await bus.subscribe({ topic: 'audit', group: 'g', consumer: 'c' });
    expect(await sub.read()).toEqual([]);
  });

  it('swallow mode logs the error and resolves null', async () => {
    const bus = new InMemoryEventBus();
    const deps = emitterDeps({ failureMode: 'swallow' });
    const emitter = createBusAuditEmitter({ ...deps, bus, topic: 'audit' });
    expect(await emitter.emit({ ...draft, action: 'BAD' })).toBeNull();
    bus.publish = () => Promise.reject(new Error('bus down'));
    expect(await emitter.emit(draft)).toBeNull();
    expect(deps.logger.records.filter((r) => r.level === 'error')).toHaveLength(2);
  });

  it('throws when the bus fails (default mode)', async () => {
    const bus = new InMemoryEventBus();
    bus.publish = () => Promise.reject(new Error('bus down'));
    const emitter = createBusAuditEmitter({ ...emitterDeps(), bus, topic: 'audit' });
    await expect(emitter.emit(draft)).rejects.toThrow('bus down');
  });
});

describe('AuditEmitter (outbox) and OutboxRelay', () => {
  it('writes to the outbox with the caller transaction, and the relay moves rows to the bus', async () => {
    const outbox = new InMemoryOutboxStore();
    const bus = new InMemoryEventBus();
    const logger = new MemoryLogger();
    const emitter = createOutboxAuditEmitter({ ...emitterDeps(), outbox });
    const sent = (await emitter.emit(draft, { tx: { fake: 'transaction' } })) as AuditEvent;
    expect(await outbox.pendingCount()).toBe(1);

    const relay = new OutboxRelay({ outbox, bus, topic: 'audit', logger });
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(await outbox.pendingCount()).toBe(0);
    const sub = await bus.subscribe({ topic: 'audit', group: 'g', consumer: 'c' });
    expect((await sub.read()).map((m) => m.payload)).toEqual([sent]);
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  it('marks rows failed when the bus is down and retries after the lease', async () => {
    const clock = new ManualClock();
    const outbox = new InMemoryOutboxStore(clock);
    const bus = new InMemoryEventBus();
    const logger = new MemoryLogger();
    await createOutboxAuditEmitter({ ...emitterDeps(), outbox }).emit(draft);
    const relay = new OutboxRelay({ outbox, bus, topic: 'audit', logger, leaseMs: 1000 });

    const publishBatch = bus.publishBatch.bind(bus);
    bus.publishBatch = () => Promise.reject(new Error('bus down'));
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(logger.records.some((r) => r.level === 'error' && r.msg === 'outbox relay failed to publish')).toBe(true);
    expect(await outbox.pendingCount()).toBe(1);

    bus.publishBatch = publishBatch;
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 }); // still leased
    clock.advance(1500);
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
  });

  it('runs in the background until stopped', async () => {
    const outbox = new InMemoryOutboxStore();
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay({ outbox, bus, topic: 'audit', logger: new MemoryLogger(), pollIntervalMs: 10 });
    relay.start();
    await createOutboxAuditEmitter({ ...emitterDeps(), outbox }).emit(draft);
    for (let i = 0; i < 50 && (await outbox.pendingCount()) > 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    await relay.stop();
    expect(await outbox.pendingCount()).toBe(0);
  });
});

function buildChain(workspaceId: string, count: number): StoredAuditEvent[] {
  const ids = new SequentialIdGenerator();
  let head: ChainLink | null = null;
  const out: StoredAuditEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const stored = chainEvent(
      {
        version: 1,
        eventId: `00000000-0000-4000-8000-${workspaceId.charCodeAt(workspaceId.length - 1).toString(16).padStart(4, '0')}${i.toString(16).padStart(8, '0')}`,
        traceId: ids.uuid(),
        spanId: ids.spanId(),
        workspaceId,
        actor: { type: 'service', id: 'hub' },
        service: 'hub',
        action: 'command.received',
        category: 'command',
        outcome: 'success',
        occurredAt: '2026-10-25T10:00:00.000Z',
        details: { i },
      },
      head,
      '2026-10-25T10:00:00.000Z'
    );
    head = { hash: stored.hash, ingestedAt: stored.ingestedAt };
    out.push(stored);
  }
  return out;
}

describe('verifyChain', () => {
  it('verifies an intact chain across pages, and per workspace', async () => {
    const store = new InMemoryAuditStore();
    await store.appendBatch([...buildChain('ws-a', 7), ...buildChain('ws-b', 3)]);
    const a = await verifyChain(store, 'ws-a', {}, { pageSize: 2 });
    expect(a).toMatchObject({ ok: true, checked: 7, complete: true, problems: [] });
    expect(await verifyChain(store, 'ws-b')).toMatchObject({ ok: true, checked: 3 });
    expect(await verifyChain(store, 'ws-empty')).toMatchObject({ ok: true, checked: 0, firstEventId: null });
  });

  it('detects an altered event', async () => {
    const chain = buildChain('ws-a', 4);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain.map((e, i) => (i === 2 ? { ...e, outcome: 'denied' as const } : e)));
    const result = await verifyChain(store, 'ws-a');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ type: 'hash_mismatch', eventId: chain[2]?.eventId })]);
  });

  it('detects a missing event, and a chain that does not start at genesis', async () => {
    const chain = buildChain('ws-a', 5);
    const store = new InMemoryAuditStore();
    await store.appendBatch([chain[0]!, chain[1]!, chain[3]!, chain[4]!]);
    expect((await verifyChain(store, 'ws-a')).problems).toEqual([
      expect.objectContaining({ type: 'broken_link', eventId: chain[3]?.eventId }),
    ]);

    const headless = new InMemoryAuditStore();
    await headless.appendBatch(chain.slice(1));
    expect((await verifyChain(headless, 'ws-a')).problems).toEqual([
      expect.objectContaining({ type: 'bad_genesis', eventId: chain[1]?.eventId }),
    ]);
  });

  it('detects ingestedAt that does not increase', async () => {
    const chain = buildChain('ws-a', 3);
    // Re-hash event 2 with the same ingestedAt as event 1 so only the ordering is wrong.
    const forged = chainEvent(
      { ...chain[2]!, version: 1 } as AuditEvent,
      { hash: chain[1]!.hash, ingestedAt: '2026-10-25T09:00:00.000Z' },
      '2026-10-25T10:00:00.001Z'
    );
    const store = new InMemoryAuditStore();
    await store.appendBatch([chain[0]!, chain[1]!, { ...forged, ingestedAt: chain[1]!.ingestedAt }]);
    const types = (await verifyChain(store, 'ws-a')).problems.map((p) => p.type);
    expect(types).toContain('non_monotonic_ingested_at');
  });

  it('verifies a range, anchoring its first event on the real predecessor', async () => {
    const chain = buildChain('ws-a', 6);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    const range = { from: chain[2]!.ingestedAt, to: chain[5]!.ingestedAt };
    const result = await verifyChain(store, 'ws-a', range, { pageSize: 2 });
    expect(result).toMatchObject({ ok: true, checked: 3, firstEventId: chain[2]?.eventId, lastEventId: chain[4]?.eventId, lastHash: chain[4]?.hash });
  });

  it('reports a range whose first event does not follow its predecessor', async () => {
    const chain = buildChain('ws-a', 4);
    const store = new InMemoryAuditStore();
    await store.appendBatch([chain[0]!, chain[2]!, chain[3]!]); // chain[1] removed
    const result = await verifyChain(store, 'ws-a', { from: chain[2]!.ingestedAt });
    expect(result.problems[0]).toMatchObject({ type: 'bad_genesis', eventId: chain[2]?.eventId });
  });

  it('stops after maxProblems', async () => {
    const chain = buildChain('ws-a', 6).map((e) => ({ ...e, outcome: 'denied' as const }));
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    const result = await verifyChain(store, 'ws-a', {}, { maxProblems: 2 });
    expect(result.problems).toHaveLength(2);
    expect(result.complete).toBe(false);
  });
});

describe('verifyChain with chain anchors', () => {
  const KEY = 'test-anchor-key-0123456789-0123456789';
  /** An anchor store holding the head of `chain` as the consumer would have written it. */
  async function anchored(chain: StoredAuditEvent[], upTo = chain.length) {
    const anchors = new InMemoryAnchorStore({ hmacKey: KEY });
    const head = chain[upTo - 1]!;
    await anchors.put({ workspaceId: head.workspaceId, headHash: head.hash, count: upTo, timestamp: head.ingestedAt });
    return anchors;
  }
  const types = (r: Awaited<ReturnType<typeof verifyChain>>) => r.problems.map((p) => p.type);

  it('passes an intact chain and reports the anchor as checked', async () => {
    const chain = buildChain('ws-a', 5);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: await anchored(chain), pageSize: 2 });
    expect(result).toMatchObject({ ok: true, checked: 5, anchor: { checked: true, count: 5, timestamp: chain[4]?.ingestedAt } });
  });

  it('accepts a live chain that is longer than the anchor (the anchor is written after the events)', async () => {
    const chain = buildChain('ws-a', 6);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: await anchored(chain, 4) });
    expect(result).toMatchObject({ ok: true, checked: 6, anchor: { checked: true, count: 4 } });
  });

  it('is silent for a workspace without an anchor', async () => {
    const store = new InMemoryAuditStore();
    await store.appendBatch(buildChain('ws-a', 3));
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: new InMemoryAnchorStore({ hmacKey: KEY }) });
    expect(result.ok).toBe(true);
    expect(result.anchor).toBeUndefined();
  });

  it('reports tail_truncated when the newest events were deleted (the shorter chain is still valid)', async () => {
    const chain = buildChain('ws-a', 6);
    const anchors = await anchored(chain);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain.slice(0, 4));
    expect(await verifyChain(store, 'ws-a')).toMatchObject({ ok: true, checked: 4 }); // without the anchor nothing is wrong
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: anchors });
    expect(result.ok).toBe(false);
    expect(types(result)).toEqual(['tail_truncated', 'tail_truncated']);
    expect(result.problems.at(-1)?.detail).toContain('2 of the newest events are missing');
  });

  it('reports tail_truncated when every event of the workspace was deleted', async () => {
    const chain = buildChain('ws-a', 3);
    const result = await verifyChain(new InMemoryAuditStore(), 'ws-a', {}, { anchorStore: await anchored(chain) });
    expect(types(result)).toContain('tail_truncated');
    expect(result.ok).toBe(false);
  });

  it('reports tail_truncated when the newest events were deleted and others written in their place', async () => {
    const chain = buildChain('ws-a', 5);
    const anchors = await anchored(chain);
    // Same length, but the last event is a different one: replaced, with a valid chain behind it.
    const replacement = chainEvent(
      { ...chain[4]!, version: 1, details: { forged: true } } as unknown as AuditEvent,
      { hash: chain[3]!.hash, ingestedAt: chain[3]!.ingestedAt },
      chain[4]!.ingestedAt
    );
    const store = new InMemoryAuditStore();
    await store.appendBatch([...chain.slice(0, 4), replacement]);
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: anchors });
    expect(types(result)).toEqual(['tail_truncated']);
    expect(result.problems[0]?.detail).toContain('replaced');
  });

  it('still reports an edited event with its own problem type (hash_mismatch), with or without anchors', async () => {
    const chain = buildChain('ws-a', 4);
    const anchors = await anchored(chain);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain.map((e, i) => (i === 2 ? { ...e, outcome: 'denied' as const } : e)));
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: anchors });
    expect(types(result)).toEqual(['hash_mismatch']);
  });

  it('still reports a deleted middle event as broken_link, and the missing count as tail_truncated', async () => {
    const chain = buildChain('ws-a', 5);
    const anchors = await anchored(chain);
    const store = new InMemoryAuditStore();
    await store.appendBatch([chain[0]!, chain[1]!, chain[3]!, chain[4]!]);
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: anchors });
    expect(types(result)).toEqual(['broken_link', 'tail_truncated']);
    expect(result.problems[1]?.detail).toContain('1 of the newest events are missing');
  });

  it('reports anchor_invalid when the anchor was changed', async () => {
    const chain = buildChain('ws-a', 4);
    const anchors = await anchored(chain);
    anchors.tamper('ws-a', { count: 1 }); // an attacker lowers the count to hide a deletion
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain.slice(0, 2));
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: anchors });
    expect(result.ok).toBe(false);
    expect(types(result)).toEqual(['anchor_invalid']);
    expect(result.anchor).toBeUndefined();
  });

  it('reports anchor_invalid when the anchor was signed with another key', async () => {
    const chain = buildChain('ws-a', 2);
    const foreign = new InMemoryAnchorStore({ hmacKey: 'another-key-another-key-another-key-00' });
    const forged = await foreign.put({ workspaceId: 'ws-a', headHash: chain[1]!.hash, count: 2, timestamp: chain[1]!.ingestedAt });
    const anchors = await anchored(chain);
    anchors.tamper('ws-a', { signature: forged.signature });
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    expect(types(await verifyChain(store, 'ws-a', {}, { anchorStore: anchors }))).toEqual(['anchor_invalid']);
  });

  it('does not compare the anchor when its head lies outside the range', async () => {
    const chain = buildChain('ws-a', 6);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    const range = { from: chain[1]!.ingestedAt, to: chain[3]!.ingestedAt };
    const result = await verifyChain(store, 'ws-a', range, { anchorStore: await anchored(chain) });
    expect(result).toMatchObject({ ok: true, anchor: { checked: false, count: 6 } });
  });

  it('does not compare the anchor when verification stopped early', async () => {
    const chain = buildChain('ws-a', 6);
    const store = new InMemoryAuditStore();
    await store.appendBatch(chain);
    const result = await verifyChain(store, 'ws-a', {}, { anchorStore: await anchored(chain), maxEvents: 3 });
    expect(result).toMatchObject({ ok: true, truncated: true, anchor: { checked: false } });
  });
});

describe('AuditedReader (self-audit of reads)', () => {
  it('emits a data_access event for each read, with filter names and result size but no values', async () => {
    const store = new InMemoryAuditStore();
    await store.appendBatch(buildChain('ws-a', 3));
    const bus = new InMemoryEventBus();
    const clock = new ManualClock();
    const emitter = createBusAuditEmitter({ ...emitterDeps(), service: 'audit-api', bus, topic: 'audit' });
    const reader = new AuditedReader(store, emitter, clock);
    const ctx = { actor: { type: 'user' as const, id: 'u1' }, workspaceId: 'ws-a', traceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

    const rows = await reader.query(ctx, { workspaceId: 'ws-a', category: 'command', limit: 2 });
    expect(rows).toHaveLength(2);
    await reader.aggregate(ctx, { filter: { workspaceId: 'ws-a' }, groupBy: ['category'] });
    await reader.getTrace(ctx, rows[0]!.traceId);

    const sub = await bus.subscribe({ topic: 'audit', group: 'g', consumer: 'c' });
    const events = (await sub.read()).map((m) => m.payload as AuditEvent);
    expect(events.map((e) => e.action)).toEqual([
      'audit.searched',
      'audit.searched',
      'audit.trace_viewed',
    ]);
    expect(events[0]).toMatchObject({
      category: 'data_access',
      service: 'audit-api',
      workspaceId: 'ws-a',
      traceId: ctx.traceId,
      outcome: 'success',
      details: { filters: ['category', 'limit', 'workspaceId'], resultCount: 2 },
    });
    expect(JSON.stringify(events[0])).not.toContain('command"'); // filter values are not recorded
  });

  it('always reads the caller\'s workspace: the session decides, not the query', async () => {
    const store = new InMemoryAuditStore();
    const mine = buildChain('ws-a', 2);
    const theirs = buildChain('ws-b', 3);
    await store.appendBatch([...mine, ...theirs]);
    const emitter = createBusAuditEmitter({ ...emitterDeps(), service: 'audit-api', bus: new InMemoryEventBus(), topic: 'audit' });
    const reader = new AuditedReader(store, emitter, new ManualClock());
    const ctx = { actor: { type: 'user' as const, id: 'u1' }, workspaceId: 'ws-a' };

    expect(await reader.query(ctx, {})).toHaveLength(2);
    expect(await reader.query(ctx, { workspaceId: 'ws-b' })).toHaveLength(2); // a request's workspace is overridden
    const rows = await reader.aggregate(ctx, { filter: { workspaceId: 'ws-b' }, groupBy: [] });
    expect(rows[0]?.count).toBe(2);
    // The generators are deterministic, so only the third event of ws-b has a trace id that ws-a does not.
    const foreignTrace = theirs[2]!.traceId;
    expect(await reader.getTrace(ctx, foreignTrace)).toEqual([]);
    expect(await reader.getTrace({ ...ctx, workspaceId: 'ws-b' }, foreignTrace)).toHaveLength(1);
  });

  it('records a failed read and rethrows', async () => {
    const store = new InMemoryAuditStore();
    store.query = () => Promise.reject(new Error('store down'));
    const bus = new InMemoryEventBus();
    const reader = new AuditedReader(store, createBusAuditEmitter({ ...emitterDeps(), bus, topic: 'audit' }), new ManualClock());
    await expect(reader.query({ actor: { type: 'user', id: 'u1' }, workspaceId: 'ws-a' }, {})).rejects.toThrow('store down');
    const sub = await bus.subscribe({ topic: 'audit', group: 'g', consumer: 'c' });
    const [m] = await sub.read();
    expect(m?.payload).toMatchObject({ outcome: 'failure', errorMessage: 'store down' });
  });
});
