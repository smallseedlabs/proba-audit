/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '@smallseedlabs/proba-audit-adapters';
import type { AuditEvent } from '@smallseedlabs/proba-audit-core';
import { FOREIGN_WORKSPACE, TOKENS, WORKSPACE, chainAll, createHarness, makeEvent, makeObservation, type Harness } from './harness.testing.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const seed = async (events: AuditEvent[]): Promise<void> => {
  await h.store.appendBatch(chainAll(events));
};

describe('health and readiness', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('answers /health and /ready without credentials and without an audit event', async () => {
    const health = await h.get('/health', null);
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', service: 'audit-api' });
    const ready = await h.get('/ready', null);
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', checks: { auditStore: 'ok' } });
    expect(await h.emitted()).toEqual([]);
  });

  it('reports not ready, without details, when a dependency is down', async () => {
    await h.close();
    h = await createHarness({ readiness: [{ name: 'eventBus', check: async () => Promise.reject(new Error('redis://secret-host refused')) }] });
    const res = await h.get('/ready', null);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { eventBus: 'unavailable' } });
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
  });

  it('puts a fresh X-Trace-Id on every response, ignoring a client-supplied one', async () => {
    const mine = randomUUID();
    const a = await h.get('/health', null, { 'x-trace-id': mine });
    const b = await h.get('/health', null);
    expect(a.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers['x-trace-id']).not.toBe(mine);
    expect(a.headers['x-trace-id']).not.toBe(b.headers['x-trace-id']);
    expect(a.headers['cache-control']).toBe('no-store');
  });

  it('is read-only: only GET routes exist', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await h.app.inject({ method, url: '/v1/events', headers: { authorization: `Bearer ${TOKENS.admin}` }, payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('authentication and authorisation', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('refuses a call without a token, with a trace id and a challenge', async () => {
    const res = await h.get('/v1/events', null);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'missing_token', traceId: res.headers['x-trace-id'] });
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
  });

  it('never accepts a token in the URL', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/events?token=${TOKENS.admin}` });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an unknown token', async () => {
    const res = await h.get('/v1/events', 'not-a-known-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
    expect(JSON.stringify(res.body)).not.toContain('not-a-known-token');
  });

  it('refuses a verified identity that is not on the allow-list, and an unverified email', async () => {
    const outsider = await h.get('/v1/events', TOKENS.outsider);
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toBe('not_allowed');
    const unverified = await h.get('/v1/events', TOKENS.unverified);
    expect(unverified.status).toBe(403);
    expect(unverified.body.error).toBe('email_not_verified');
  });

  it('allows the allow-list (viewer), an allowed domain (viewer) and the admin list (admin)', async () => {
    const viewer = await h.get('/v1/session', TOKENS.viewer);
    expect(viewer.body).toEqual({ subject: 'uid-viewer', email: 'viewer@insights.example', role: 'viewer', workspaceId: WORKSPACE });
    expect((await h.get('/v1/session', TOKENS.domain)).body.role).toBe('viewer');
    expect((await h.get('/v1/session', TOKENS.admin)).body.role).toBe('admin');
  });

  it('allows nobody when no access is configured', async () => {
    await h.close();
    h = await createHarness({ env: { AUDIT_API_ALLOWED_EMAILS: '', AUDIT_API_ALLOWED_EMAIL_DOMAINS: '', AUDIT_API_ADMIN_EMAILS: '' } });
    expect((await h.get('/v1/events', TOKENS.admin)).status).toBe(403);
  });

  it('audits refusals as auth.denied with the reason, but never the token', async () => {
    await h.get('/v1/events', null);
    await h.get('/v1/events', TOKENS.outsider);
    const denied = (await h.emitted()).filter((e) => e.action === 'auth.denied');
    expect(denied.map((e) => [e.errorCode, e.outcome])).toEqual([
      ['missing_token', 'failure'],
      ['not_allowed', 'denied'],
    ]);
    expect(denied[1].actor).toEqual({ type: 'user', id: 'uid-outsider' });
    expect(JSON.stringify(denied)).not.toContain(TOKENS.outsider);
    expect(JSON.stringify(denied)).not.toContain('stranger@');
  });
});

describe('workspace scope comes from the session only', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('rejects a workspaceId (or any unknown) query parameter', async () => {
    for (const path of [`/v1/events?workspaceId=${FOREIGN_WORKSPACE}`, '/v1/traces?workspace=x', '/v1/facets?workspaceId=x', '/v1/analytics/summary?workspaceId=x&from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z']) {
      const res = await h.get(path);
      expect(res.status, path).toBe(400);
      expect(res.body.error).toBe('invalid_query');
      expect(res.body.issues[0].message).toMatch(/unknown parameter/);
    }
  });

  it('never returns another workspace`s events, event, trace or facets', async () => {
    const foreign = makeEvent({ workspaceId: FOREIGN_WORKSPACE, action: 'goal.created', category: 'data_access', service: 'foreign-service' });
    const mine = makeEvent({ action: 'command.received' });
    await seed([foreign, mine]);

    const events = await h.get('/v1/events?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z');
    expect(events.body.events.map((e: any) => e.eventId)).toEqual([mine.eventId]);
    expect((await h.get(`/v1/events/${foreign.eventId}`)).status).toBe(404);
    expect((await h.get(`/v1/traces/${foreign.traceId}`)).status).toBe(404);
    expect((await h.get(`/v1/events?traceId=${foreign.traceId}`)).body.events).toEqual([]);
    const facets = await h.get('/v1/facets?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z');
    expect(facets.body.facets.service.map((v: any) => v.value)).toEqual(['hub']);
    const traces = await h.get('/v1/traces?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z');
    expect(traces.body.traces.map((t: any) => t.traceId)).toEqual([mine.traceId]);
  });
});

describe('GET /v1/events', () => {
  const day = 'from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z';
  beforeEach(async () => {
    h = await createHarness();
  });

  it('filters by every supported field and combines them with AND', async () => {
    const goalId = randomUUID();
    const threadId = randomUUID();
    const traceId = randomUUID();
    const target = makeEvent({ occurredAt: '2026-10-25T10:00:01.000Z', action: 'campaign.launched', category: 'command', outcome: 'failure', riskLevel: 'high', service: 'hub', actor: { type: 'user', id: 'u-42' }, goalId, threadId, campaignId: 'cmp_77', traceId, target: { type: 'campaign', id: 'Spring-Sale' } });
    await seed([target, makeEvent({ occurredAt: '2026-10-25T10:00:02.000Z', action: 'brain.llm_call', category: 'brain', service: 'brain' }), makeEvent({ occurredAt: '2026-10-24T10:00:02.000Z' })]);
    const ids = async (query: string) => (await h.get(`/v1/events?${day}&${query}`)).body.events.map((e: any) => e.eventId);
    for (const q of ['traceId=' + traceId, 'actor=u-42', 'actorType=user', 'service=hub&outcome=failure', 'action=campaign.launched', 'category=command&riskLevel=high', `goalId=${goalId}`, `threadId=${threadId}`, 'campaignId=cmp_77', 'q=spring', 'q=LAUNCH']) {
      expect(await ids(q), q).toEqual([target.eventId]);
    }
    expect(await ids('action=campaign.launched&outcome=success')).toEqual([]);
    const all = await h.get(`/v1/events?${day}`);
    expect(all.body.events).toHaveLength(2); // the 2026-10-24 event is outside the range
    expect(all.body).toMatchObject({ order: 'desc', limit: 50, from: '2026-10-25T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
  });

  it('sorts by occurredAt in both orders and pages with a cursor without gaps or repeats', async () => {
    const events = Array.from({ length: 7 }, (_, i) => makeEvent({ occurredAt: `2026-10-25T10:00:0${Math.floor(i / 2)}.000Z`, details: { i } }));
    await seed(events);
    for (const order of ['asc', 'desc'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: any = await h.get(`/v1/events?${day}&order=${order}&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        seen.push(...res.body.events.map((e: any) => e.eventId));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 5);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(7);
      const times = seen.map((id) => events.find((e) => e.eventId === id)!.occurredAt);
      expect(times).toEqual([...times].sort(order === 'asc' ? undefined : (a, b) => b.localeCompare(a)));
    }
  });

  it('caps the page size and validates every parameter', async () => {
    const bad: [string, string][] = [
      ['limit=201', 'limit'],
      ['limit=0', 'limit'],
      ['limit=abc', 'limit'],
      ['order=sideways', 'order'],
      ['traceId=nope', 'traceId'],
      ['from=yesterday', 'from'],
      ['from=2026-10-25T10:00:00%2B02:00', 'from'],
      ['category=bogus', 'category'],
      ['outcome=meh', 'outcome'],
      ['riskLevel=extreme', 'riskLevel'],
      ['q=a', 'q'],
      ['q=' + 'x'.repeat(101), 'q'],
      ['action=Has%20Spaces', 'action'],
      ['campaignId=' + 'c'.repeat(129), 'campaignId'],
      ['cursor=' + 'c'.repeat(513), 'cursor'],
      ['cursor=garbage', 'cursor'],
      ['sql=1%3D1', '(root)'],
    ];
    for (const [query, field] of bad) {
      const res = await h.get(`/v1/events?${day.replace(/from=[^&]*&?/, '')}&${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.issues.map((i: any) => i.path), query).toContain(field);
    }
    const ok = await h.get('/v1/events?limit=200');
    expect(ok.status).toBe(200);
  });

  it('refuses ranges that are unordered or longer than 90 days, and defaults to the last 24 hours', async () => {
    expect((await h.get('/v1/events?from=2026-10-26T00:00:00Z&to=2026-10-25T00:00:00Z')).status).toBe(400);
    expect((await h.get('/v1/events?from=2026-01-01T00:00:00Z&to=2026-10-25T00:00:00Z')).status).toBe(400);
    await seed([makeEvent({ occurredAt: '2026-10-25T11:00:00.000Z' }), makeEvent({ occurredAt: '2026-10-24T11:00:00.000Z' })]); // clock is 2026-10-25T12:00Z
    const res = await h.get('/v1/events');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.from).toBe('2026-10-24T12:00:00.000Z');
  });

  it('rejects a cursor issued for the other order', async () => {
    await seed([makeEvent(), makeEvent(), makeEvent()]);
    const first = await h.get(`/v1/events?${day}&limit=1&order=desc`);
    const res = await h.get(`/v1/events?${day}&limit=1&order=asc&cursor=${first.body.nextCursor}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cursor');
  });

  it('returns one event by id, with its chain fields, and 404 / 400 otherwise', async () => {
    const e = makeEvent({ details: { note: 'x' } });
    await seed([e]);
    const res = await h.get(`/v1/events/${e.eventId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eventId: e.eventId, details: { note: 'x' }, prevHash: null, schemaVersion: 1 });
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.get(`/v1/events/${randomUUID()}`)).status).toBe(404);
    expect((await h.get('/v1/events/not-a-uuid')).status).toBe(400);
  });
});

describe('traces', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  const span = (n: number) => `a${n.toString(16).padStart(15, '0')}`;

  it('returns a trace as a span tree with durations, outcome roll-up, orphans and related ids', async () => {
    const traceId = randomUUID();
    const goalId = randomUUID();
    const t = (s: number) => `2026-10-25T10:00:0${s}.000Z`;
    await seed([
      makeEvent({ traceId, spanId: span(1), occurredAt: t(0), action: 'command.received', durationMs: 10, goalId }),
      makeEvent({ traceId, spanId: span(2), parentSpanId: span(1), occurredAt: t(1), action: 'brain.llm_call', category: 'brain', durationMs: 2500, outcome: 'success', riskLevel: 'low' }),
      makeEvent({ traceId, spanId: span(3), parentSpanId: span(2), occurredAt: t(2), action: 'tool.failed', category: 'tool', outcome: 'failure', errorCode: 'TIMEOUT', riskLevel: 'medium' }),
      makeEvent({ traceId, spanId: span(4), parentSpanId: span(1), occurredAt: t(3), action: 'policy.denied', category: 'policy', outcome: 'denied', campaignId: 'cmp_1' }),
      makeEvent({ traceId, spanId: span(5), parentSpanId: span(9), occurredAt: t(4), action: 'system.job_run', category: 'system' }), // parent never stored
    ]);
    const res = await h.get(`/v1/traces/${traceId}`);
    expect(res.status).toBe(200);
    const tree = res.body;
    expect(tree).toMatchObject({ traceId, eventCount: 5, outcome: 'failure', riskLevel: 'medium', truncated: false, startedAt: t(0), durationMs: 4000 });
    expect(tree.endedAt).toBe(t(4));
    expect(tree.related).toEqual({ goalIds: [goalId], threadIds: [], campaignIds: ['cmp_1'] });
    expect(tree.roots.map((n: any) => [n.action, n.orphan ?? false])).toEqual([['command.received', false], ['system.job_run', true]]);
    const root = tree.roots[0];
    expect(root).toMatchObject({ offsetMs: 0, durationMs: 10, subtreeOutcome: 'failure' });
    expect(root.children.map((n: any) => n.action)).toEqual(['brain.llm_call', 'policy.denied']);
    const llm = root.children[0];
    expect(llm).toMatchObject({ offsetMs: 1000, durationMs: 2500, outcome: 'success', subtreeOutcome: 'failure' });
    expect(llm.children[0]).toMatchObject({ action: 'tool.failed', errorCode: 'TIMEOUT', subtreeOutcome: 'failure', children: [] });
    expect(root.children[1]).toMatchObject({ outcome: 'denied', subtreeOutcome: 'denied', durationMs: null });
  });

  it('survives a loop in the parent links', async () => {
    const traceId = randomUUID();
    await seed([
      makeEvent({ traceId, spanId: span(1), parentSpanId: span(2), occurredAt: '2026-10-25T10:00:00.000Z' }),
      makeEvent({ traceId, spanId: span(2), parentSpanId: span(1), occurredAt: '2026-10-25T10:00:01.000Z' }),
    ]);
    const res = await h.get(`/v1/traces/${traceId}`);
    expect(res.status).toBe(200);
    expect(res.body.roots.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(res.body)).not.toThrow();
  });

  it('lists recent traces with a summary, newest first, with a cursor', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await seed(
      ids.flatMap((traceId, i) => [
        makeEvent({ traceId, spanId: span(i * 10 + 1), occurredAt: `2026-10-25T10:0${i}:00.000Z`, action: i === 1 ? 'auth.sign_in' : 'command.received', category: i === 1 ? 'auth' : 'command', durationMs: 5 }),
        makeEvent({ traceId, spanId: span(i * 10 + 2), parentSpanId: span(i * 10 + 1), occurredAt: `2026-10-25T10:0${i}:01.000Z`, outcome: i === 2 ? 'failure' : 'success', durationMs: 100 }),
      ])
    );
    const page1 = await h.get('/v1/traces?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.traces.map((t: any) => t.traceId)).toEqual([ids[2], ids[1]]);
    expect(page1.body.traces[0]).toMatchObject({ rootAction: 'command.received', rootService: 'hub', eventCount: 2, outcome: 'failure', durationMs: 1100 });
    expect(page1.body.traces[1].rootAction).toBe('auth.sign_in');
    const page2 = await h.get(`/v1/traces?limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.traces.map((t: any) => t.traceId)).toEqual([ids[0]]);
    expect(page2.body.nextCursor).toBeNull();
    expect((await h.get('/v1/traces?limit=101')).status).toBe(400);
    expect((await h.get('/v1/traces?from=2026-10-01T00:00:00Z&to=2026-10-25T00:00:00Z')).status).toBe(400); // longer than 7 days
  });
});

describe('GET /v1/chain/verify', () => {
  const range = 'from=2026-10-25T10:00:00Z&to=2026-10-25T11:00:00Z';
  beforeEach(async () => {
    h = await createHarness();
  });

  it('is for administrators only', async () => {
    const res = await h.get(`/v1/chain/verify?${range}`, TOKENS.viewer);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_role');
  });

  it('verifies the callers workspace chain over the range', async () => {
    const events = Array.from({ length: 5 }, () => makeEvent());
    await seed([...events, makeEvent({ workspaceId: FOREIGN_WORKSPACE })]);
    const res = await h.get(`/v1/chain/verify?${range}`, TOKENS.admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workspaceId: WORKSPACE, ok: true, checked: 5, problems: [], complete: true, firstEventId: events[0].eventId, lastEventId: events[4].eventId });
  });

  it('reports a broken chain with the offending event', async () => {
    const chained = chainAll([makeEvent(), makeEvent(), makeEvent()]);
    chained[1] = { ...chained[1], details: { altered: true } }; // content no longer matches its hash
    await h.store.appendBatch(chained);
    const res = await h.get(`/v1/chain/verify?${range}`, TOKENS.admin);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.problems).toEqual([expect.objectContaining({ type: 'hash_mismatch', eventId: chained[1].eventId })]);
  });

  it('bounds the range and the number of events checked', async () => {
    expect((await h.get('/v1/chain/verify', TOKENS.admin)).status).toBe(400);
    expect((await h.get('/v1/chain/verify?from=2026-10-25T10:00:00Z', TOKENS.admin)).status).toBe(400);
    expect((await h.get('/v1/chain/verify?from=2026-10-25T10:00:00Z&to=2026-10-25T09:00:00Z', TOKENS.admin)).status).toBe(400);
    const tooLong = await h.get('/v1/chain/verify?from=2026-10-24T10:00:00Z&to=2026-10-25T10:00:01Z', TOKENS.admin);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.issues[0].message).toMatch(/longer than 24 hours/);

    await h.close();
    h = await createHarness({ env: { AUDIT_API_CHAIN_MAX_EVENTS: '3' } });
    await seed(Array.from({ length: 6 }, () => makeEvent()));
    const res = await h.get(`/v1/chain/verify?${range}`, TOKENS.admin);
    expect(res.body).toMatchObject({ checked: 3, truncated: true });
  });

  it('has its own, lower rate limit', async () => {
    await h.close();
    h = await createHarness({ env: { AUDIT_API_CHAIN_RATE_LIMIT_MAX: '2' } });
    expect((await h.get(`/v1/chain/verify?${range}`, TOKENS.admin)).status).toBe(200);
    expect((await h.get(`/v1/chain/verify?${range}`, TOKENS.admin)).status).toBe(200);
    const limited = await h.get(`/v1/chain/verify?${range}`, TOKENS.admin);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await h.get('/v1/events', TOKENS.admin)).status).toBe(200); // other routes are unaffected
  });
});

describe('analytics', () => {
  const day = (n: number) => `2026-10-${n}T00:00:00Z`;
  beforeEach(async () => {
    h = await createHarness();
    const hours = (campaignId: string, base: number, date: string) =>
      Array.from({ length: 3 }, (_, i) =>
        makeObservation({
          campaignId,
          periodStart: `${date}T0${i}:00:00.000Z`,
          periodEnd: `${date}T0${i + 1}:00:00.000Z`,
          metrics: { impressions: base * 100, clicks: base * 10, spend: base, conversions: base / 10 },
          fetchedAt: '2026-10-25T09:00:00.000Z',
        })
      );
    await h.metrics.upsertObservations([
      ...hours('cmp_big', 10, '2026-10-25'),
      ...hours('cmp_small', 1, '2026-10-25'),
      ...hours('cmp_big', 5, '2026-10-24'),
      makeObservation({ accountId: 'act_foreign', campaignId: 'cmp_foreign', periodStart: '2026-10-25T00:00:00.000Z', periodEnd: '2026-10-25T01:00:00.000Z', metrics: { impressions: 999999, clicks: 1, spend: 999, conversions: 1 } }),
    ]);
    await h.metrics.computeRollups({ bucket: 'hour', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
    await h.metrics.computeRollups({ bucket: 'day', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
  });

  it('serves the summary with totals, a series and freshness, only for the workspace accounts', async () => {
    const res = await h.get(`/v1/analytics/summary?from=${day(25)}&to=${day(26)}&granularity=hour`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual([expect.objectContaining({ currency: 'USD', impressions: 3300, clicks: 330, spend: 33 })]); // act_foreign is not in scope
    expect(res.body.series).toHaveLength(3);
    expect(res.body.campaigns.map((c: any) => c.campaignId)).toEqual(['cmp_big', 'cmp_small']);
    expect(res.body.freshness.observationsFetchedAt).toBe('2026-10-25T09:00:00.000Z');
    expect(res.body.freshness.rollupsComputedAt).toBe('2026-10-25T12:00:00.000Z'); // the harness clock
    expect(res.body.freshness.asOf).toBe('2026-10-25T09:00:00.000Z');
  });

  it('compares two periods', async () => {
    const res = await h.get(`/v1/analytics/compare?granularity=hour&currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-25T03:00:00Z&previousFrom=2026-10-24T00:00:00Z&previousTo=2026-10-24T03:00:00Z`);
    expect(res.status).toBe(200);
    expect(res.body.comparison[0].spend).toMatchObject({ current: 33, previous: 15, change: 18 });
    expect(res.body.freshness.asOf).not.toBeNull();
    expect((await h.get('/v1/analytics/compare?currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-26T00:00:00Z&previousFrom=2026-10-24T00:00:00Z')).status).toBe(400);
  });

  it('lists top campaigns by spend, capped', async () => {
    const res = await h.get(`/v1/analytics/campaigns?from=${day(25)}&to=${day(26)}&granularity=hour&limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.campaigns.map((c: any) => c.campaignId)).toEqual(['cmp_big']);
    expect(res.body.truncated).toBe(true);
    expect((await h.get(`/v1/analytics/campaigns?from=${day(25)}&to=${day(26)}&limit=101`)).status).toBe(400);
  });

  it('turns analytics validation errors into 400s with the offending fields', async () => {
    const res = await h.get(`/v1/analytics/summary?from=2026-10-25T00:30:00Z&to=${day(26)}&granularity=hour`);
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([expect.objectContaining({ path: 'from', message: expect.stringContaining('on the hour') })]);
    expect((await h.get('/v1/analytics/summary')).status).toBe(400);
  });

  it('reports no freshness when there is no data', async () => {
    await h.close();
    h = await createHarness();
    const res = await h.get(`/v1/analytics/summary?from=${day(25)}&to=${day(26)}`);
    expect(res.status).toBe(200);
    expect(res.body.freshness).toEqual({ asOf: null, rollupsComputedAt: null, observationsFetchedAt: null });
  });
});

describe('GET /v1/facets', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('returns distinct values with counts and caps them', async () => {
    await seed(Array.from({ length: 5 }, (_, i) => makeEvent({ occurredAt: '2026-10-25T10:00:00.000Z', service: `svc-${i}`, action: i < 3 ? 'command.received' : 'goal.created' })));
    const res = await h.get('/v1/facets?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z&limit=3');
    expect(res.status).toBe(200);
    expect(res.body.facets.service).toHaveLength(3);
    expect(res.body.truncated).toContain('service');
    expect(res.body.facets.action[0]).toEqual({ value: 'command.received', count: 3 });
    expect(Object.keys(res.body.facets).sort()).toEqual(['action', 'actorId', 'actorType', 'campaignId', 'category', 'outcome', 'riskLevel', 'service']);
    expect((await h.get('/v1/facets?limit=101')).status).toBe(400);
  });
});

describe('every call is audited', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('emits one audit.searched per search under the response trace id, naming filters but never values', async () => {
    const res = await h.get('/v1/events?q=secret-search-text&actor=u-secret&limit=5');
    const events = await h.emitted();
    expect(events).toHaveLength(1);
    const [read] = events;
    expect(read).toMatchObject({
      action: 'audit.searched',
      category: 'data_access',
      outcome: 'success',
      workspaceId: WORKSPACE,
      service: 'audit-api',
      traceId: res.headers['x-trace-id'],
      actor: { type: 'user', id: 'uid-viewer' },
      target: { type: 'audit_events', id: WORKSPACE },
    });
    expect(read.details).toMatchObject({ operation: 'events.search', route: 'GET /v1/events', role: 'viewer', resultCount: 0 });
    expect(read.details.filters).toEqual(expect.arrayContaining(['q', 'actor', 'limit']));
    expect(JSON.stringify(read)).not.toContain('secret-search-text');
    expect(JSON.stringify(read)).not.toContain('u-secret');
    expect(JSON.stringify(read)).not.toContain('viewer@insights');
  });

  it('records the operation for each route, and the metrics actions for analytics', async () => {
    const e = makeEvent();
    await seed([e]);
    await h.get(`/v1/events/${e.eventId}`);
    await h.get(`/v1/traces/${e.traceId}`);
    await h.get('/v1/traces');
    await h.get('/v1/facets');
    await h.get('/v1/session');
    await h.get('/v1/chain/verify?from=2026-10-25T10:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.admin);
    await h.get('/v1/analytics/summary?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z');
    await h.get('/v1/analytics/compare?currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-26T00:00:00Z');
    await h.get('/v1/analytics/campaigns?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z');
    const emitted = await h.emitted();
    expect(emitted.map((x) => [x.action, x.details.operation])).toEqual([
      ['audit.event_viewed', 'events.get'],
      ['audit.trace_viewed', 'traces.get'],
      ['audit.searched', 'traces.list'],
      ['audit.searched', 'facets.list'],
      // /v1/session is not recorded: it reads nothing from the audit trail or the metrics.
      ['audit.integrity_checked', 'chain.verify'],
      ['analytics.queried', undefined],
      ['analytics.compared', undefined],
      ['analytics.queried', undefined],
    ]);
    expect(new Set(emitted.map((x) => x.traceId)).size).toBe(emitted.length); // one trace per request
  });

  it('audits a failed read as a failure, and refuses to return data when the audit event cannot be sent', async () => {
    await h.close();
    h = await createHarness({
      emitter: (_bus, base) => ({
        forTrace: (traceId, parent) => ({ ...base.forTrace(traceId, parent), emit: async () => Promise.reject(new Error('bus down')) }),
        emit: () => Promise.reject(new Error('bus down')),
      }),
    });
    await seed([makeEvent({ occurredAt: '2026-10-25T11:00:00.000Z' })]);
    const res = await h.get('/v1/events');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'internal_error', traceId: res.headers['x-trace-id'] });
    expect(JSON.stringify(res.body)).not.toContain('bus down');
    expect(res.body.events).toBeUndefined();
  });

  it('turns an unexpected error into a generic 500 and a system.error event', async () => {
    h.store.search = async () => Promise.reject(new Error('disk exploded: /var/secret/path'));
    const res = await h.get('/v1/events');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
    const emitted = await h.emitted();
    expect(emitted.map((x) => x.action)).toEqual(['audit.searched', 'system.error']); // the failed read, then the error
    expect(emitted[0].outcome).toBe('failure');
    expect(emitted[1]).toMatchObject({ outcome: 'failure', errorCode: 'unhandled_error', target: { type: 'route', id: 'GET /v1/events' } });
  });
});

describe('rate limiting', () => {
  it('limits each caller and tells them when to retry', async () => {
    h = await createHarness({ env: { AUDIT_API_RATE_LIMIT_MAX: '3', AUDIT_API_RATE_LIMIT_WINDOW_MS: '60000' } });
    const first = await h.get('/v1/session');
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    await h.get('/v1/session');
    await h.get('/v1/session');
    const blocked = await h.get('/v1/session');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBe('60');
    expect((await h.get('/v1/session', TOKENS.admin)).status).toBe(200); // another caller is unaffected
    h.clock.advance(61_000);
    expect((await h.get('/v1/session')).status).toBe(200);
  });

  it('refuses a client that keeps presenting bad credentials, and audits only a few of the refusals', async () => {
    h = await createHarness({ env: { AUDIT_API_AUTH_FAILURE_LIMIT_MAX: '3' } });
    for (let i = 0; i < 3; i += 1) expect((await h.get('/v1/events', `bad-token-${i}`)).status).toBe(401);
    const blocked = await h.get('/v1/events', TOKENS.admin); // even a good token is refused from this address now
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    const denied = (await h.emitted()).filter((e) => e.action === 'auth.denied');
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied.length).toBeLessThanOrEqual(5);
  });

  it('uses the injected limiter port', async () => {
    const limiter = new InMemoryRateLimiter();
    h = await createHarness({ limiter });
    await h.get('/v1/session');
    expect((await limiter.peek('user:uid-viewer', 10, 60_000)).remaining).toBe(9);
  });
});

describe('CORS', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('allows the configured portal origin only, and exposes the trace id', async () => {
    const ok = await h.get('/v1/session', TOKENS.viewer, { origin: 'http://localhost:5173' });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(ok.headers['access-control-expose-headers'])).toContain('X-Trace-Id');
    const other = await h.get('/v1/session', TOKENS.viewer, { origin: 'https://evil.example' });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight for the portal origin without credentials', async () => {
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/v1/events',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(res.headers['access-control-allow-methods'])).toBe('GET, OPTIONS');
    const denied = await h.app.inject({ method: 'OPTIONS', url: '/v1/events', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows no cross-origin access when no origin is configured', async () => {
    await h.close();
    h = await createHarness({ env: { AUDIT_API_CORS_ORIGINS: '' } });
    const res = await h.get('/v1/session', TOKENS.viewer, { origin: 'http://localhost:5173' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('logging', () => {
  it('writes one structured line per request with the trace id, never the token or the query values', async () => {
    h = await createHarness();
    const res = await h.get('/v1/events?q=private-words', TOKENS.viewer);
    const line = h.logger.records.find((r) => r.msg === 'request completed');
    expect(line?.fields).toMatchObject({
      traceId: res.headers['x-trace-id'],
      method: 'GET',
      route: '/v1/events',
      statusCode: 200,
      actor: 'uid-viewer',
      role: 'viewer',
      workspaceId: WORKSPACE,
      queryParams: ['q'],
    });
    expect(typeof line?.fields.durationMs).toBe('number');
    const all = JSON.stringify(h.logger.records);
    expect(all).not.toContain(TOKENS.viewer);
    expect(all).not.toContain('private-words');
    expect(all).not.toContain('viewer@insights');
  });
});
