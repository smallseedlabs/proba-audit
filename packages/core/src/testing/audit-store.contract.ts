import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuditStore } from '../ports/audit-store.js';
import { makeStoredAuditEvent, randomHash, uniqueName } from './fixtures.js';

export interface AuditStoreHarness {
  store: AuditStore;
  cleanup?: () => Promise<void>;
}

/**
 * Contract any AuditStore adapter must satisfy. Each test uses its own
 * workspaceId, so one shared database can run the whole suite.
 */
export function runAuditStoreContract(name: string, factory: () => Promise<AuditStoreHarness>): void {
  describe(`AuditStore contract: ${name}`, () => {
    const harnesses: AuditStoreHarness[] = [];
    async function create(): Promise<AuditStore> {
      const h = await factory();
      harnesses.push(h);
      return h.store;
    }
    afterEach(async () => {
      while (harnesses.length) {
        const h = harnesses.pop()!;
        await h.store.close();
        await h.cleanup?.();
      }
    });

    it('pings', async () => {
      await expect((await create()).ping()).resolves.toBeUndefined();
    });

    it('appends a batch and reads it back unchanged', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const full = makeStoredAuditEvent({
        workspaceId,
        userId: randomUUID(),
        goalId: randomUUID(),
        threadId: randomUUID(),
        campaignId: 'cmp_123',
        parentSpanId: 'aaaaaaaaaaaaaaaa',
        target: { type: 'goal', id: 'g-1' },
        outcome: 'failure',
        errorCode: 'TIMEOUT',
        errorMessage: 'upstream timed out',
        riskLevel: 'high',
        cost: { tokensIn: 1200, tokensOut: 300, currency: 'USD', amount: 0.0123 },
        durationMs: 842,
        details: { model: 'x', nested: { a: [1, 2] } },
        tags: ['llm', 'retry'],
        prevHash: randomHash(),
      });
      const minimal = makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T10:00:05.000Z' });
      const result = await store.appendBatch([full, minimal]);
      expect(result).toEqual({ inserted: 2, duplicates: 0, conflicts: [] });

      const got = await store.query({ workspaceId, order: 'asc' });
      expect(got).toHaveLength(2);
      expect(got[0]).toEqual(full);
      expect(got[1]).toEqual(minimal);
    });

    it('ignores events whose eventId is already stored, including within one batch', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const e = makeStoredAuditEvent({ workspaceId });
      expect(await store.appendBatch([e, e])).toEqual({ inserted: 1, duplicates: 1, conflicts: [] });
      expect(await store.appendBatch([e])).toEqual({ inserted: 0, duplicates: 1, conflicts: [] });
      expect(await store.query({ workspaceId })).toHaveLength(1);
    });

    it('treats a redelivery that differs only in chain fields as a duplicate', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const e = makeStoredAuditEvent({ workspaceId });
      await store.appendBatch([e]);
      const rechained = { ...e, prevHash: randomHash(), hash: randomHash(), ingestedAt: '2026-10-25T10:05:00.000Z' };
      expect(await store.appendBatch([rechained])).toEqual({ inserted: 0, duplicates: 1, conflicts: [] });
    });

    it('does not write an eventId that is stored with different content and reports it as a conflict', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const e = makeStoredAuditEvent({ workspaceId, action: 'command.received' });
      await store.appendBatch([e]);
      const altered = { ...e, action: 'command.rejected', outcome: 'denied' as const };
      const other = makeStoredAuditEvent({ workspaceId });
      const result = await store.appendBatch([altered, other]);
      expect(result).toEqual({ inserted: 1, duplicates: 0, conflicts: [e.eventId] });
      const stored = await store.query({ workspaceId, order: 'asc' });
      expect(stored).toHaveLength(2);
      expect(stored.find((x) => x.eventId === e.eventId)?.action).toBe('command.received');
    });

    it('reports a conflict between two events with the same id inside one batch (first wins)', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const e = makeStoredAuditEvent({ workspaceId, action: 'command.received' });
      const clash = { ...e, action: 'command.rejected' };
      expect(await store.appendBatch([e, clash])).toEqual({ inserted: 1, duplicates: 0, conflicts: [e.eventId] });
      expect((await store.query({ workspaceId }))[0]?.action).toBe('command.received');
    });

    it('finds existing events by reference', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const a = makeStoredAuditEvent({ workspaceId });
      const b = makeStoredAuditEvent({ workspaceId });
      const missing = makeStoredAuditEvent({ workspaceId });
      await store.appendBatch([a, b]);
      const found = await store.findExisting([a, b, missing].map((e) => ({ eventId: e.eventId, workspaceId, occurredAt: e.occurredAt })));
      expect(found.map((e) => e.eventId).sort()).toEqual([a.eventId, b.eventId].sort());
      expect(found.find((e) => e.eventId === a.eventId)).toEqual(a);
      expect(await store.findExisting([])).toEqual([]);
    });

    it('reads a workspace in chain order with ranges, cursors and descending order', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const at = (s: number) => `2026-10-25T10:00:0${s}.000Z`;
      const events = [1, 2, 3, 4].map((i) => makeStoredAuditEvent({ workspaceId, ingestedAt: at(i), details: { i } }));
      await store.appendBatch([events[2]!, events[0]!, events[3]!, events[1]!]);
      await store.appendBatch([makeStoredAuditEvent({ workspaceId: uniqueName('other'), ingestedAt: at(2) })]);
      const idx = (r: { details: Record<string, unknown> }[]) => r.map((e) => e.details.i);
      expect(idx(await store.readChain(workspaceId))).toEqual([1, 2, 3, 4]);
      expect(idx(await store.readChain(workspaceId, { order: 'desc', limit: 2 }))).toEqual([4, 3]);
      expect(idx(await store.readChain(workspaceId, { from: at(2), to: at(4) }))).toEqual([2, 3]);
      expect(idx(await store.readChain(workspaceId, { to: at(3), order: 'desc', limit: 1 }))).toEqual([2]);
      const page1 = await store.readChain(workspaceId, { limit: 2 });
      const tail = page1[1]!;
      expect(idx(await store.readChain(workspaceId, { limit: 2, after: { ingestedAt: tail.ingestedAt, eventId: tail.eventId } }))).toEqual([3, 4]);
      expect(await store.readChain(uniqueName('empty'))).toEqual([]);
    });

    it('appends an empty batch as a no-op', async () => {
      expect(await (await create()).appendBatch([])).toEqual({ inserted: 0, duplicates: 0, conflicts: [] });
    });

    it('returns a whole trace oldest first', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const traceId = randomUUID();
      const t = (s: number) => `2026-10-25T10:00:0${s}.000Z`;
      await store.appendBatch([
        makeStoredAuditEvent({ workspaceId, traceId, occurredAt: t(3), action: 'command.processed' }),
        makeStoredAuditEvent({ workspaceId, traceId, occurredAt: t(1), action: 'command.received' }),
        makeStoredAuditEvent({ workspaceId, traceId, occurredAt: t(2), action: 'brain.llm_call', category: 'brain' }),
        makeStoredAuditEvent({ workspaceId, occurredAt: t(2) }), // other trace
      ]);
      const trace = await store.getTrace(traceId, { workspaceId });
      expect(trace.map((e) => e.action)).toEqual(['command.received', 'brain.llm_call', 'command.processed']);
      expect(trace.every((e) => e.traceId === traceId)).toBe(true);
    });

    it('filters by category, outcome, actor, service, action, ids and time range', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      const goalId = randomUUID();
      await store.appendBatch([
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T10:00:00.000Z', category: 'command', action: 'command.received' }),
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T11:00:00.000Z', category: 'brain', action: 'brain.llm_call', actor: { type: 'brain', id: 'b1' }, service: 'brain', goalId }),
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T12:00:00.000Z', category: 'policy', action: 'policy.denied', outcome: 'denied', riskLevel: 'high' }),
      ]);
      const q = (f: object) => store.query({ workspaceId, order: 'asc', ...f });
      expect((await q({ category: 'brain' })).map((e) => e.action)).toEqual(['brain.llm_call']);
      expect((await q({ outcome: 'denied' })).map((e) => e.action)).toEqual(['policy.denied']);
      expect((await q({ actorType: 'brain', actorId: 'b1' })).length).toBe(1);
      expect((await q({ service: 'brain' })).length).toBe(1);
      expect((await q({ action: 'command.received' })).length).toBe(1);
      expect((await q({ goalId })).length).toBe(1);
      expect((await q({ riskLevel: 'high' })).length).toBe(1);
      // from inclusive, to exclusive
      expect((await q({ from: '2026-10-25T11:00:00.000Z' })).length).toBe(2);
      expect((await q({ to: '2026-10-25T11:00:00.000Z' })).length).toBe(1);
      expect((await q({ from: '2026-10-25T10:30:00.000Z', to: '2026-10-25T11:30:00.000Z' })).length).toBe(1);
    });

    it('isolates workspaces', async () => {
      const store = await create();
      const a = uniqueName('ws');
      const b = uniqueName('ws');
      await store.appendBatch([makeStoredAuditEvent({ workspaceId: a }), makeStoredAuditEvent({ workspaceId: b })]);
      expect(await store.query({ workspaceId: a })).toHaveLength(1);
      expect(await store.query({ workspaceId: b })).toHaveLength(1);
    });

    it('orders, limits and offsets', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      await store.appendBatch(
        [1, 2, 3, 4, 5].map((i) => makeStoredAuditEvent({ workspaceId, occurredAt: `2026-10-25T10:00:0${i}.000Z`, details: { i } }))
      );
      const idx = (r: { details: Record<string, unknown> }[]) => r.map((e) => e.details.i);
      expect(idx(await store.query({ workspaceId, order: 'asc', limit: 2 }))).toEqual([1, 2]);
      expect(idx(await store.query({ workspaceId, order: 'asc', limit: 2, offset: 2 }))).toEqual([3, 4]);
      expect(idx(await store.query({ workspaceId }))).toEqual([5, 4, 3, 2, 1]); // default newest first
    });

    it('aggregates counts, duration, tokens and cost by group', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      await store.appendBatch([
        makeStoredAuditEvent({ workspaceId, category: 'brain', outcome: 'success', durationMs: 100, cost: { tokensIn: 10, tokensOut: 5, currency: 'USD', amount: 0.5 } }),
        makeStoredAuditEvent({ workspaceId, category: 'brain', outcome: 'failure', durationMs: 50, cost: { tokensIn: 20, tokensOut: 10, currency: 'USD', amount: 0.25 } }),
        makeStoredAuditEvent({ workspaceId, category: 'command', outcome: 'success' }),
      ]);
      const byCategory = await store.aggregate({ filter: { workspaceId }, groupBy: ['category'] });
      expect(byCategory).toEqual([
        { keys: { category: 'brain' }, count: 2, durationMsSum: 150, tokensInSum: 30, tokensOutSum: 15, costAmountSum: 0.75 },
        { keys: { category: 'command' }, count: 1, durationMsSum: 0, tokensInSum: 0, tokensOutSum: 0, costAmountSum: 0 },
      ]);
      const total = await store.aggregate({ filter: { workspaceId }, groupBy: [] });
      expect(total).toHaveLength(1);
      expect(total[0].count).toBe(3);
      const byCatOutcome = await store.aggregate({ filter: { workspaceId, category: 'brain' }, groupBy: ['outcome'] });
      expect(byCatOutcome.map((r) => [r.keys.outcome, r.count])).toEqual([['failure', 1], ['success', 1]]);
    });

    it('aggregates into UTC hour and day buckets', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      await store.appendBatch([
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T10:05:00.000Z' }),
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T10:55:00.000Z' }),
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-25T11:05:00.000Z' }),
        makeStoredAuditEvent({ workspaceId, occurredAt: '2026-10-26T00:05:00.000Z' }),
      ]);
      const hours = await store.aggregate({ filter: { workspaceId }, groupBy: ['hour'] });
      expect(hours.map((r) => [r.keys.hour, r.count])).toEqual([
        ['2026-10-25T10:00:00.000Z', 2],
        ['2026-10-25T11:00:00.000Z', 1],
        ['2026-10-26T00:00:00.000Z', 1],
      ]);
      const days = await store.aggregate({ filter: { workspaceId }, groupBy: ['day'] });
      expect(days.map((r) => [r.keys.day, r.count])).toEqual([
        ['2026-10-25T00:00:00.000Z', 3],
        ['2026-10-26T00:00:00.000Z', 1],
      ]);
    });

    it('reports the chain head: latest ingested event of the workspace', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      expect(await store.getChainHead(workspaceId)).toBeNull();
      const first = makeStoredAuditEvent({ workspaceId, ingestedAt: '2026-10-25T10:00:01.000Z' });
      const second = makeStoredAuditEvent({ workspaceId, ingestedAt: '2026-10-25T10:00:02.000Z', prevHash: first.hash });
      await store.appendBatch([second, first]);
      expect(await store.getChainHead(workspaceId)).toEqual({
        eventId: second.eventId,
        hash: second.hash,
        ingestedAt: second.ingestedAt,
      });
    });
  });
}
