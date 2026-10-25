/**
 * End-to-end tests of the audit pipeline against the real services: Redis
 * Streams (bus), ClickHouse (store) and Postgres (outbox). Every test uses its
 * own topic, group and workspaces, so one shared stack can run them all.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  OutboxRelay,
  createOutboxAuditEmitter,
  loadConfig,
  verifyChain,
  type AuditEvent,
} from '@smallseedlabs/proba-audit-core';
import { uniqueName } from '@smallseedlabs/proba-audit-core/testing';
import {
  ClickHouseAuditStore,
  PostgresOutboxStore,
  RandomIdGenerator,
  RedisStreamsEventBus,
  SystemClock,
  clickHouseMigrationDb,
  createClickHouseClient,
  ensureDatabase,
  loadMigrations,
  runMigrations,
  type ClickHouseOptions,
} from '@smallseedlabs/proba-audit-adapters';
import { ConsumerHarness, makeEvent } from './harness.testing.js';

const config = loadConfig(process.env);
const chOptions: ClickHouseOptions = { ...config.clickhouse, database: process.env.CLICKHOUSE_TEST_DATABASE ?? 'proba_audit_test' };
const migrationsDir = resolve(__dirname, '../../../migrations/clickhouse');
const pgUrl = process.env.OUTBOX_TEST_DATABASE_URL ?? 'postgresql://proba:proba@localhost:5432/proba_audit_outbox_test';

const clock = new SystemClock();
const ids = new RandomIdGenerator();

beforeAll(async () => {
  await ensureDatabase(chOptions);
  const client = createClickHouseClient(chOptions);
  await runMigrations(clickHouseMigrationDb(client), loadMigrations(migrationsDir));
  await client.close();
});

interface Stack {
  h: ConsumerHarness;
  bus: RedisStreamsEventBus;
  store: ClickHouseAuditStore;
  topic: string;
  group: string;
  ws: (n: string) => string;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** A consumer wired to real Redis and ClickHouse. Pass topic/group/bus/store to share them (restart, second consumer). */
function stack(options: { topic?: string; group?: string; bus?: RedisStreamsEventBus; store?: ClickHouseAuditStore; consumerName?: string; selfAudit?: boolean; overrides?: object } = {}): Stack {
  const topic = options.topic ?? uniqueName('topic');
  const group = options.group ?? uniqueName('group');
  const bus = options.bus ?? new RedisStreamsEventBus({ url: config.eventBus.redisUrl });
  const store = options.store ?? new ClickHouseAuditStore({ client: createClickHouseClient(chOptions), ownsClient: true });
  const h = new ConsumerHarness({
    bus,
    store,
    clock,
    ids,
    topic,
    group,
    selfAudit: options.selfAudit ?? false,
    consumerName: options.consumerName,
    overrides: { blockMs: 100, retryBaseMs: 20, retryMaxMs: 100, ...options.overrides },
  });
  closers.push(async () => {
    await h.close();
    if (!options.bus) await bus.close();
    if (!options.store) await store.close();
  });
  return { h, bus, store, topic, group, ws: (n) => `${n}-${topic}` };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

const count = async (store: ClickHouseAuditStore, workspaceId: string) => (await store.readChain(workspaceId, { limit: 10_000 })).length;

describe('audit pipeline: Redis -> consumer -> ClickHouse', () => {
  it('ingests events for several workspaces over many batches with one verified chain per workspace', async () => {
    const s = stack({ overrides: { batchSize: 7 } });
    const [a, b] = [s.ws('a'), s.ws('b')];
    await s.h.consumer.start();
    for (let round = 0; round < 6; round += 1) {
      await s.h.publish(...Array.from({ length: 5 }, (_, i) => makeEvent({ workspaceId: i % 2 === 0 ? a : b, details: { round, i } })));
    }
    await waitFor(async () => (await count(s.store, a)) === 18 && (await count(s.store, b)) === 12);
    await waitFor(async () => (await s.h.pending()) === 0);

    const [va, vb] = [await verifyChain(s.store, a, {}, { pageSize: 5 }), await verifyChain(s.store, b, {}, { pageSize: 5 })];
    expect(va).toMatchObject({ ok: true, checked: 18, complete: true });
    expect(vb).toMatchObject({ ok: true, checked: 12, complete: true });
    const first = (await s.store.readChain(a, { limit: 1 }))[0];
    expect(first?.prevHash).toBeNull();
    expect(first?.tags).toEqual(expect.arrayContaining(['category:command', 'outcome:success', 'service:hub']));
    expect(s.h.errors()).toEqual([]);
  });

  it('continues each chain after a restart, recovering the head from ClickHouse', async () => {
    const first = stack();
    const ws = first.ws('r');
    await first.h.publish(...Array.from({ length: 4 }, () => makeEvent({ workspaceId: ws })));
    await first.h.pump();
    await first.h.close();

    const second = stack({ topic: first.topic, group: first.group, bus: first.bus, store: first.store, consumerName: 'consumer-2' });
    await second.h.publish(...Array.from({ length: 3 }, () => makeEvent({ workspaceId: ws })));
    await second.h.pump();
    expect(second.h.logger.records.some((r) => r.msg === 'chain head recovered from store' && r.fields.workspaceId === ws)).toBe(true);
    expect(await verifyChain(first.store, ws)).toMatchObject({ ok: true, checked: 7 });
  });

  it('survives a crash between the durable write and the XACK (no duplicate rows, chain intact)', async () => {
    const crashing = stack({ consumerName: 'crashing' });
    const ws = crashing.ws('c');
    await crashing.h.publish(...Array.from({ length: 5 }, () => makeEvent({ workspaceId: ws })));
    const messages = await crashing.h.read();
    const sub = await crashing.h.consumer.attach();
    sub.ack = () => Promise.reject(new Error('killed before XACK'));
    await expect(crashing.h.consumer.processBatch(messages)).rejects.toThrow('killed');
    expect(await count(crashing.store, ws)).toBe(5);
    await crashing.h.close();

    // A new process in the same group takes the pending messages over with the reclaim loop.
    const recovery = stack({
      topic: crashing.topic,
      group: crashing.group,
      bus: crashing.bus,
      store: crashing.store,
      consumerName: 'recovery',
      overrides: { claimIdleMs: 100, reclaimIntervalMs: 100 },
    });
    await new Promise((r) => setTimeout(r, 150));
    await recovery.h.consumer.start();
    await waitFor(async () => (await recovery.h.pending()) === 0);
    expect(await count(crashing.store, ws)).toBe(5);
    expect(await verifyChain(crashing.store, ws)).toMatchObject({ ok: true, checked: 5 });
    expect(recovery.h.logger.records.some((r) => r.msg === 'reclaimed pending messages')).toBe(true);
    expect(recovery.h.errors()).toEqual([]);
  });

  it('survives a crash before the write: the reclaiming consumer writes the events once', async () => {
    const dead = stack({ consumerName: 'dead' });
    const ws = dead.ws('d');
    await dead.h.publish(...Array.from({ length: 4 }, () => makeEvent({ workspaceId: ws })));
    expect(await dead.h.read()).toHaveLength(4); // delivered, never processed
    await dead.h.close();

    const live = stack({
      topic: dead.topic,
      group: dead.group,
      bus: dead.bus,
      store: dead.store,
      consumerName: 'live',
      overrides: { claimIdleMs: 100, reclaimIntervalMs: 100 },
    });
    await new Promise((r) => setTimeout(r, 150));
    await live.h.consumer.start();
    await waitFor(async () => (await count(dead.store, ws)) === 4);
    await waitFor(async () => (await live.h.pending()) === 0);
    expect(await verifyChain(dead.store, ws)).toMatchObject({ ok: true, checked: 4 });
  });

  it('handles duplicates: identical redeliveries are skipped, conflicting content goes to the real DLQ', async () => {
    const s = stack();
    const ws = s.ws('dup');
    const e = makeEvent({ workspaceId: ws, action: 'command.received' });
    await s.h.publish(e, makeEvent({ workspaceId: ws }));
    await s.h.pump();
    const clash = { ...e, action: 'command.rejected', outcome: 'denied' as const };
    await s.h.publish(e, clash, makeEvent({ workspaceId: ws }));
    const { result } = await s.h.pump();

    expect(result).toMatchObject({ written: 1, duplicates: 1, conflicts: 1 });
    expect(await count(s.store, ws)).toBe(3);
    const stored = (await s.store.findExisting([{ eventId: e.eventId, workspaceId: ws, occurredAt: e.occurredAt }]))[0];
    expect(stored?.action).toBe('command.received');
    const dead = await s.bus.listDeadLetters<AuditEvent>(s.topic);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toMatch(new RegExp(`${e.eventId}.*different content`));
    expect(dead[0]?.payload).toEqual(clash);
    expect(s.h.errors().some((r) => r.fields.eventId === e.eventId && r.fields.traceId === e.traceId)).toBe(true);
    expect(await s.h.pending()).toBe(0);
    expect(await verifyChain(s.store, ws)).toMatchObject({ ok: true, checked: 3 });
  });

  it('dead-letters invalid events with a reason and keeps processing the valid ones', async () => {
    const s = stack();
    const ws = s.ws('inv');
    await s.h.publish({ ...makeEvent({ workspaceId: ws }), spanId: 'not-hex' }, makeEvent({ workspaceId: ws }), 'garbage', { traceId: 5 });
    const { result } = await s.h.pump();
    expect(result).toMatchObject({ written: 1, invalid: 3 });
    const dead = await s.bus.listDeadLetters(s.topic);
    expect(dead).toHaveLength(3);
    expect(dead.every((d) => d.reason.startsWith('invalid audit event:'))).toBe(true);
    expect(dead.some((d) => d.reason.includes('spanId'))).toBe(true);
    expect(await s.h.pending()).toBe(0);
    expect(await count(s.store, ws)).toBe(1);
  });

  it('keeps the chain verifiable through ClickHouse storage precision (microseconds, long decimals)', async () => {
    const s = stack();
    const ws = s.ws('prec');
    await s.h.publish(
      makeEvent({ workspaceId: ws, occurredAt: '2026-10-25T10:00:00.123456Z', cost: { amount: 0.123456789123, currency: 'USD', tokensIn: 7 }, durationMs: 12.5, details: { nested: { b: 1, a: [1, 2, { z: 1, y: 2 }] }, unicode: 'héllo ✓' } }),
      makeEvent({ workspaceId: ws, errorMessage: 'boom', riskLevel: 'high', target: { type: 'goal', id: 'g1' } })
    );
    await s.h.pump();
    expect(await verifyChain(s.store, ws)).toMatchObject({ ok: true, checked: 2 });
  });

  it('detects tampering with a stored row', async () => {
    const s = stack();
    const ws = s.ws('tamper');
    await s.h.publish(...Array.from({ length: 5 }, (_, i) => makeEvent({ workspaceId: ws, details: { i } })));
    await s.h.pump();
    expect(await verifyChain(s.store, ws)).toMatchObject({ ok: true });
    const victim = (await s.store.readChain(ws))[2]!;

    const admin = createClickHouseClient(chOptions);
    try {
      await admin.command({
        query: `ALTER TABLE audit_events UPDATE outcome = 'denied' WHERE event_id = {id:UUID}`,
        query_params: { id: victim.eventId },
        clickhouse_settings: { mutations_sync: '2' },
      });
    } finally {
      await admin.close();
    }
    const result = await verifyChain(s.store, ws);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ type: 'hash_mismatch', eventId: victim.eventId })]);
  });

  it('audits itself through the same bus and stores those events in the chain', async () => {
    const s = stack({ selfAudit: true });
    const ws = s.ws('self');
    await s.h.consumer.start();
    await s.h.publish(makeEvent({ workspaceId: ws }), makeEvent({ workspaceId: ws }));
    await waitFor(async () => (await count(s.store, ws)) === 3);
    await new Promise((r) => setTimeout(r, 400)); // no further feedback events may appear
    const events = await s.store.readChain(ws);
    expect(events.map((e) => e.action).sort()).toEqual(['command.received', 'command.received', 'system.audit_batch_processed']);
    const self = events.find((e) => e.service === 'audit-consumer');
    expect(self).toMatchObject({ category: 'system', actor: { type: 'service', id: 'audit-consumer' }, outcome: 'success' });
    expect(await count(s.store, ws)).toBe(3);
    expect(await verifyChain(s.store, ws)).toMatchObject({ ok: true, checked: 3 });
  });
});

describe('audit pipeline: Postgres outbox -> relay -> Redis -> consumer -> ClickHouse', () => {
  const pool = new pg.Pool({ connectionString: pgUrl });
  afterAll(() => pool.end());

  it('delivers events written in a service transaction, and never those of a rolled-back one', async () => {
    const table = `audit_outbox_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const outbox = new PostgresOutboxStore({ pool, table });
    await outbox.ensureSchema();
    closers.push(async () => void (await pool.query(`DROP TABLE IF EXISTS ${table}`)));

    const s = stack();
    const ws = s.ws('outbox');
    const emitter = createOutboxAuditEmitter({ service: 'hub', defaultWorkspaceId: ws, clock, ids, logger: s.h.logger, outbox });
    const relay = new OutboxRelay({ outbox, bus: s.bus, topic: s.topic, logger: s.h.logger, pollIntervalMs: 50, leaseMs: 1000 });
    const traceId = randomUUID();

    const tx = await pool.connect();
    await tx.query('BEGIN');
    await emitter.forTrace(traceId).emit({ actor: { type: 'user', id: 'u1' }, action: 'command.accepted', category: 'command', outcome: 'success' }, { tx });
    await emitter.forTrace(traceId).emit({ actor: { type: 'user', id: 'u1' }, action: 'command.processed', category: 'command', outcome: 'success' }, { tx });
    await tx.query('COMMIT');
    tx.release();

    const failing = await pool.connect();
    await failing.query('BEGIN');
    await emitter.emit({ actor: { type: 'user', id: 'u2' }, action: 'command.accepted', category: 'command', outcome: 'success' }, { tx: failing });
    await failing.query('ROLLBACK');
    failing.release();

    await s.h.consumer.start();
    relay.start();
    await waitFor(async () => (await count(s.store, ws)) === 2);
    await relay.stop();
    await waitFor(async () => (await outbox.pendingCount()) === 0);

    const trace = await s.store.getTrace(traceId, { workspaceId: ws });
    expect(trace.map((e) => e.action)).toEqual(['command.accepted', 'command.processed']);
    expect(await count(s.store, ws)).toBe(2);
    expect(await verifyChain(s.store, ws)).toMatchObject({ ok: true, checked: 2 });
  });
});
