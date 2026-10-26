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
        contentDigest: randomHash(),
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
      const trace = await store.getTrace(workspaceId, traceId);
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

    // The same trace id exists in two workspaces. Every read must return the workspace it was asked for, and an
    // event of one workspace must be unreachable from another by id, trace, time, search, facet or chain.
    describe('workspace isolation', () => {
      const t = (min: number) => `2026-10-25T10:${String(min).padStart(2, '0')}:00.000Z`;

      async function twoWorkspaces() {
        const store = await create();
        const a = uniqueName('wsa');
        const b = uniqueName('wsb');
        const traceId = randomUUID();
        const ea = [1, 2].map((i) => makeStoredAuditEvent({ workspaceId: a, traceId, occurredAt: t(i), ingestedAt: t(i), service: 'svc-a', campaignId: 'cmp_a', action: 'goal.created' }));
        const eb = [3, 4, 5].map((i) => makeStoredAuditEvent({ workspaceId: b, traceId, occurredAt: t(i), ingestedAt: t(i), service: 'svc-b', campaignId: 'cmp_b', action: 'goal.updated' }));
        await store.appendBatch([...ea, ...eb]);
        return { store, a, b, traceId, ea, eb };
      }
      const ids = (events: { eventId: string }[]) => events.map((e) => e.eventId).sort();

      it('getTrace returns the trace of the workspace asked for, never the same trace id of another', async () => {
        const { store, a, b, traceId, ea, eb } = await twoWorkspaces();
        expect(ids(await store.getTrace(a, traceId))).toEqual(ids(ea));
        expect(ids(await store.getTrace(b, traceId))).toEqual(ids(eb));
        expect(await store.getTrace(uniqueName('wsc'), traceId)).toEqual([]);
      });

      it('query and aggregate stay inside the workspace in the filter, and a trace id filter does not widen it', async () => {
        const { store, a, b, traceId, ea, eb } = await twoWorkspaces();
        expect(ids(await store.query({ workspaceId: a, traceId }))).toEqual(ids(ea));
        expect(ids(await store.query({ workspaceId: b, service: 'svc-a' }))).toEqual([]);
        expect(ids(await store.query({ workspaceId: b, campaignId: 'cmp_a' }))).toEqual([]);
        expect((await store.aggregate({ filter: { workspaceId: a, traceId }, groupBy: [] }))[0]?.count).toBe(2);
        expect((await store.aggregate({ filter: { workspaceId: b }, groupBy: ['service'] })).map((r) => [r.keys.service, r.count])).toEqual([['svc-b', 3]]);
        expect(ids(await store.query({ workspaceId: b }))).toEqual(ids(eb));
      });

      it('search, getEvent and findExisting do not return another workspace\'s events', async () => {
        const { store, a, b, traceId, ea, eb } = await twoWorkspaces();
        expect(ids((await store.search({ workspaceId: a, traceId })).events)).toEqual(ids(ea));
        expect(ids((await store.search({ workspaceId: b, text: 'goal.created' })).events)).toEqual([]);
        expect(await store.getEvent(a, eb[0]!.eventId)).toBeNull();
        expect(await store.getEvent(b, ea[0]!.eventId)).toBeNull();
        const ref = (e: (typeof ea)[number], workspaceId: string) => ({ eventId: e.eventId, workspaceId, occurredAt: e.occurredAt });
        expect(await store.findExisting([ref(ea[0]!, b), ref(eb[0]!, a)])).toEqual([]);
        expect(ids(await store.findExisting([ref(ea[0]!, a), ref(eb[0]!, b)]))).toEqual(ids([ea[0]!, eb[0]!]));
      });

      it('listTraces and facets summarise the workspace asked for only', async () => {
        const { store, a, b, traceId } = await twoWorkspaces();
        const listed = await store.listTraces({ workspaceId: a });
        expect(listed.traces.map((x) => [x.traceId, x.eventCount])).toEqual([[traceId, 2]]);
        expect((await store.listTraces({ workspaceId: b })).traces.map((x) => x.eventCount)).toEqual([3]);
        const facets = await store.facets({ workspaceId: a });
        expect(facets.facets.service).toEqual([{ value: 'svc-a', count: 2 }]);
        expect(facets.facets.campaignId).toEqual([{ value: 'cmp_a', count: 2 }]);
      });

      it('readChain and getChainHead follow one workspace only', async () => {
        const { store, a, b, ea, eb } = await twoWorkspaces();
        expect(ids(await store.readChain(a))).toEqual(ids(ea));
        expect(ids(await store.readChain(b))).toEqual(ids(eb));
        expect((await store.getChainHead(a))?.eventId).toBe(ea[1]!.eventId);
        expect((await store.getChainHead(b))?.eventId).toBe(eb[2]!.eventId);
        expect(await store.getChainHead(uniqueName('wsc'))).toBeNull();
      });
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

    it('counts the events of one workspace', async () => {
      const store = await create();
      const workspaceId = uniqueName('ws');
      expect(await store.countEvents(workspaceId)).toBe(0);
      const first = makeStoredAuditEvent({ workspaceId, ingestedAt: '2026-10-25T10:00:01.000Z' });
      const second = makeStoredAuditEvent({ workspaceId, ingestedAt: '2026-10-25T10:00:02.000Z', prevHash: first.hash });
      await store.appendBatch([first, second, makeStoredAuditEvent({ workspaceId: uniqueName('other') })]);
      await store.appendBatch([first]); // an identical redelivery is not counted twice
      expect(await store.countEvents(workspaceId)).toBe(2);
    });

    describe('read API', () => {
      const t = (min: number, sec = 0) => `2026-10-25T10:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000Z`;

      it('searches with every filter, combined with AND, and scopes to the workspace', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        const other = uniqueName('ws');
        const goalId = randomUUID();
        const threadId = randomUUID();
        const traceId = randomUUID();
        await store.appendBatch([
          makeStoredAuditEvent({ workspaceId, occurredAt: t(1), action: 'campaign.launched', category: 'command', campaignId: 'cmp_9', riskLevel: 'high', actor: { type: 'user', id: 'u-1' }, service: 'hub', goalId, threadId, traceId, target: { type: 'campaign', id: 'cmp_9' } }),
          makeStoredAuditEvent({ workspaceId, occurredAt: t(2), action: 'brain.llm_call', category: 'brain', outcome: 'failure', actor: { type: 'brain', id: 'b-1' }, service: 'brain' }),
          makeStoredAuditEvent({ workspaceId: other, occurredAt: t(2), action: 'campaign.launched', campaignId: 'cmp_9' }),
        ]);
        const q = async (f: object) => (await store.search({ workspaceId, ...f })).events.map((e) => e.action);
        expect(await q({})).toEqual(['brain.llm_call', 'campaign.launched']);
        expect(await q({ campaignId: 'cmp_9' })).toEqual(['campaign.launched']);
        expect(await q({ traceId })).toEqual(['campaign.launched']);
        expect(await q({ goalId, threadId })).toEqual(['campaign.launched']);
        expect(await q({ actorId: 'u-1' })).toEqual(['campaign.launched']);
        expect(await q({ actorType: 'brain' })).toEqual(['brain.llm_call']);
        expect(await q({ outcome: 'failure', category: 'brain', service: 'brain' })).toEqual(['brain.llm_call']);
        expect(await q({ riskLevel: 'high' })).toEqual(['campaign.launched']);
        expect(await q({ action: 'campaign.launched', riskLevel: 'low' })).toEqual([]);
        expect(await q({ from: t(2) })).toEqual(['brain.llm_call']);
        expect(await q({ to: t(2) })).toEqual(['campaign.launched']);
      });

      it('searches free text on action and target, ignoring case and treating wildcards literally', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        await store.appendBatch([
          makeStoredAuditEvent({ workspaceId, occurredAt: t(1), action: 'campaign.launched', target: { type: 'campaign', id: 'Spring_Sale_50%' } }),
          makeStoredAuditEvent({ workspaceId, occurredAt: t(2), action: 'goal.created', target: { type: 'goal', id: 'g-1' } }),
          makeStoredAuditEvent({ workspaceId, occurredAt: t(3), action: 'auth.sign_in' }),
        ]);
        const q = async (text: string) => (await store.search({ workspaceId, text, order: 'asc' })).events.map((e) => e.action);
        expect(await q('LAUNCH')).toEqual(['campaign.launched']);
        expect(await q('spring_sale')).toEqual(['campaign.launched']);
        expect(await q('50%')).toEqual(['campaign.launched']);
        expect(await q('%')).toEqual(['campaign.launched']);
        expect(await q('goal')).toEqual(['goal.created']);
        expect(await q('campaign')).toEqual(['campaign.launched']);
        expect(await q('nothing-like-this')).toEqual([]);
      });

      it('pages with a keyset cursor in both orders without gaps or repeats, even with equal timestamps', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        const events = Array.from({ length: 7 }, (_, i) =>
          makeStoredAuditEvent({ workspaceId, occurredAt: t(Math.floor(i / 2)), details: { i } })
        );
        await store.appendBatch(events);
        for (const order of ['asc', 'desc'] as const) {
          const seen: string[] = [];
          let after: { occurredAt: string; eventId: string } | undefined;
          let pages = 0;
          do {
            const page = await store.search({ workspaceId, order, limit: 3, after });
            expect(page.events.length).toBeLessThanOrEqual(3);
            seen.push(...page.events.map((e) => e.eventId));
            after = page.nextCursor ?? undefined;
            pages += 1;
          } while (after && pages < 10);
          expect(pages).toBe(3);
          expect(seen).toHaveLength(7);
          expect(new Set(seen).size).toBe(7);
          const times = seen.map((id) => events.find((e) => e.eventId === id)!.occurredAt);
          const sorted = [...times].sort();
          expect(times).toEqual(order === 'asc' ? sorted : sorted.reverse());
        }
        const exact = await store.search({ workspaceId, limit: 7 });
        expect(exact.events).toHaveLength(7);
        expect(exact.nextCursor).toBeNull();
      });

      it('caps the page size', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        await store.appendBatch([makeStoredAuditEvent({ workspaceId })]);
        const page = await store.search({ workspaceId, limit: 1_000_000 });
        expect(page.events).toHaveLength(1);
      });

      it('gets one event by id, only inside its workspace', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        const e = makeStoredAuditEvent({ workspaceId, details: { a: 1 }, tags: ['x'] });
        await store.appendBatch([e]);
        expect(await store.getEvent(workspaceId, e.eventId)).toEqual(e);
        expect(await store.getEvent(uniqueName('ws'), e.eventId)).toBeNull();
        expect(await store.getEvent(workspaceId, randomUUID())).toBeNull();
      });

      it('lists recent traces newest first with a summary of the whole trace', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        const a = randomUUID();
        const b = randomUUID();
        const c = randomUUID();
        await store.appendBatch([
          // trace a: root + child failure + denied sibling, high risk; ends 3s after the last start
          makeStoredAuditEvent({ workspaceId, traceId: a, spanId: '1000000000000001', occurredAt: t(1), action: 'command.received', service: 'hub', durationMs: 5 }),
          makeStoredAuditEvent({ workspaceId, traceId: a, spanId: '1000000000000002', parentSpanId: '1000000000000001', occurredAt: t(1, 2), action: 'brain.llm_call', category: 'brain', outcome: 'failure', riskLevel: 'medium', durationMs: 3000, service: 'brain' }),
          makeStoredAuditEvent({ workspaceId, traceId: a, spanId: '1000000000000003', parentSpanId: '1000000000000001', occurredAt: t(1, 3), action: 'policy.denied', category: 'policy', outcome: 'denied', riskLevel: 'high' }),
          // trace b: single success
          makeStoredAuditEvent({ workspaceId, traceId: b, spanId: '2000000000000001', occurredAt: t(5), action: 'auth.sign_in', category: 'auth', service: 'hub' }),
          // trace c: started before the window, active inside it
          makeStoredAuditEvent({ workspaceId, traceId: c, spanId: '3000000000000001', occurredAt: t(0), action: 'goal.created', category: 'data_access' }),
          makeStoredAuditEvent({ workspaceId, traceId: c, spanId: '3000000000000002', parentSpanId: '3000000000000001', occurredAt: t(8), action: 'goal.updated', category: 'data_access', outcome: 'partial' }),
          makeStoredAuditEvent({ workspaceId: uniqueName('ws'), occurredAt: t(9) }),
        ]);
        const page = await store.listTraces({ workspaceId, from: t(1), to: t(10) });
        expect(page.traces.map((x) => x.traceId)).toEqual([c, b, a]);
        expect(page.nextCursor).toBeNull();
        const [sc, sb, sa] = page.traces;
        expect(sa).toEqual({
          traceId: a,
          rootAction: 'command.received',
          rootService: 'hub',
          startedAt: t(1),
          lastEventAt: t(1, 3),
          eventCount: 3,
          outcome: 'failure',
          riskLevel: 'high',
          durationMs: 5000, // 10:01:02 + 3000 ms = 10:01:05 is the latest end; the trace began at 10:01:00
        });
        expect(sb).toMatchObject({ rootAction: 'auth.sign_in', eventCount: 1, outcome: 'success', durationMs: 0 });
        expect(sb.riskLevel).toBeUndefined();
        // The summary covers the event before the window too.
        expect(sc).toMatchObject({ rootAction: 'goal.created', eventCount: 2, startedAt: t(0), lastEventAt: t(8), outcome: 'partial' });
      });

      it('pages the trace list with a cursor', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        const ids = Array.from({ length: 5 }, () => randomUUID());
        await store.appendBatch(ids.map((traceId, i) => makeStoredAuditEvent({ workspaceId, traceId, occurredAt: t(i) })));
        const seen: string[] = [];
        let after;
        let pages = 0;
        do {
          const page: Awaited<ReturnType<typeof store.listTraces>> = await store.listTraces({ workspaceId, limit: 2, after });
          seen.push(...page.traces.map((x) => x.traceId));
          after = page.nextCursor ?? undefined;
          pages += 1;
        } while (after && pages < 10);
        expect(pages).toBe(3);
        expect(seen).toEqual([...ids].reverse());
        expect(await store.listTraces({ workspaceId: uniqueName('ws') })).toEqual({ traces: [], nextCursor: null });
      });

      it('returns capped facets with counts, most frequent first', async () => {
        const store = await create();
        const workspaceId = uniqueName('ws');
        await store.appendBatch([
          makeStoredAuditEvent({ workspaceId, occurredAt: t(1), service: 'hub', action: 'command.received', campaignId: 'cmp_a' }),
          makeStoredAuditEvent({ workspaceId, occurredAt: t(2), service: 'hub', action: 'command.received', campaignId: 'cmp_a', riskLevel: 'high' }),
          makeStoredAuditEvent({ workspaceId, occurredAt: t(3), service: 'brain', action: 'brain.llm_call', category: 'brain', actor: { type: 'brain', id: 'b-1' }, outcome: 'failure' }),
          makeStoredAuditEvent({ workspaceId, occurredAt: t(30), service: 'late', action: 'system.started', category: 'system' }),
          makeStoredAuditEvent({ workspaceId: uniqueName('ws'), service: 'foreign' }),
        ]);
        const all = await store.facets({ workspaceId, from: t(0), to: t(10) });
        expect(all.facets.service).toEqual([{ value: 'hub', count: 2 }, { value: 'brain', count: 1 }]);
        expect(all.facets.action[0]).toEqual({ value: 'command.received', count: 2 });
        expect(all.facets.outcome).toEqual([{ value: 'success', count: 2 }, { value: 'failure', count: 1 }]);
        expect(all.facets.riskLevel).toEqual([{ value: 'high', count: 1 }]);
        expect(all.facets.campaignId).toEqual([{ value: 'cmp_a', count: 2 }]);
        expect(all.facets.actorType.map((v) => v.value).sort()).toEqual(['brain', 'service']);
        expect(all.facets.category.map((v) => v.value).sort()).toEqual(['brain', 'command']);
        expect(all.truncated).toEqual([]);
        const capped = await store.facets({ workspaceId, from: t(0), to: t(10), limit: 1 });
        expect(capped.facets.service).toEqual([{ value: 'hub', count: 2 }]);
        expect(capped.truncated).toContain('service');
        expect(capped.truncated).not.toContain('riskLevel');
        const wide = await store.facets({ workspaceId });
        expect(wide.facets.service.map((v) => v.value)).toContain('late');
        expect(wide.facets.service.map((v) => v.value)).not.toContain('foreign');
      });
    });
  });
}
