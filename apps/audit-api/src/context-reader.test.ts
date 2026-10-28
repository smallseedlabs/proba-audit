/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * The `context-reader` role: a service token and an act-as assertion, a user's own events, traces and campaign analytics, never
 * anybody else's and never raw text. Other users and another workspace are seeded as canaries: none of them may show up in any answer.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuditContent, type AuditEvent } from '@smallseedlabs/proba-audit-core';
import { FOREIGN_WORKSPACE, TOKENS, WORKSPACE, chainAll, createHarness, makeEvent, makeObservation, seedWithContent, type Harness } from './harness.testing.js';
import { API_LIMITS } from './http/schemas.js';

const USER = randomUUID();
const OTHER_USER = randomUUID();
const GOAL = randomUUID();
const OTHER_GOAL = randomUUID();
const FOREIGN_GOAL = randomUUID();
const span = (n: number) => `b${n.toString(16).padStart(15, '0')}`;
const at = (minutes: number) => new Date(Date.parse('2026-10-25T10:00:00.000Z') + minutes * 60_000).toISOString();
const user = (id: string) => ({ type: 'user' as const, id });

const TRACE_OWN = randomUUID(); // root: USER, a brain step below
const TRACE_OTHER = randomUUID(); // root: OTHER_USER, with one step of USER below
const TRACE_FOREIGN = randomUUID(); // root: USER, in another workspace
const SECRET_TEXT = 'my private plan: launch on friday';

let h: Harness;
let ownEvents: string[] = [];
let ownEventWithText = '';
let canaryEvents: string[] = [];

beforeAll(async () => {
  h = await createHarness({ contextReader: true, env: { AUDIT_CONTENT_ENABLED: 'true' } });
  const events: AuditEvent[] = [
    // USER: a goal with a campaign, a trace, and plain events.
    makeEvent({ actor: user(USER), userId: USER, action: 'goal.created', category: 'command', goalId: GOAL, occurredAt: at(0) }),
    makeEvent({ actor: user(USER), action: 'thread.message_received', category: 'command', goalId: GOAL, occurredAt: at(1) }),
    makeEvent({ actor: { type: 'brain', id: 'brain' }, action: 'campaign.created', category: 'command', goalId: GOAL, campaignId: 'cmp_own', occurredAt: at(2) }),
    makeEvent({ traceId: TRACE_OWN, spanId: span(1), actor: user(USER), action: 'goal.updated', category: 'command', goalId: GOAL, occurredAt: at(3) }),
    makeEvent({ traceId: TRACE_OWN, spanId: span(2), parentSpanId: span(1), actor: { type: 'brain', id: 'brain-7' }, action: 'brain.reply_generated', category: 'brain', occurredAt: at(4) }),
    // OTHER_USER: canaries in the same workspace.
    makeEvent({ actor: user(OTHER_USER), userId: OTHER_USER, action: 'goal.created', category: 'command', goalId: OTHER_GOAL, occurredAt: at(5) }),
    makeEvent({ actor: user(OTHER_USER), action: 'thread.message_received', category: 'command', goalId: OTHER_GOAL, occurredAt: at(6) }),
    makeEvent({ actor: { type: 'brain', id: 'brain' }, action: 'campaign.created', category: 'command', goalId: OTHER_GOAL, campaignId: 'cmp_other', occurredAt: at(7) }),
    makeEvent({ traceId: TRACE_OTHER, spanId: span(1), actor: user(OTHER_USER), action: 'goal.updated', category: 'command', goalId: OTHER_GOAL, occurredAt: at(8) }),
    makeEvent({ traceId: TRACE_OTHER, spanId: span(2), parentSpanId: span(1), actor: user(USER), action: 'approval.granted', category: 'approval', occurredAt: at(9) }),
    // The same user id in another workspace.
    makeEvent({ workspaceId: FOREIGN_WORKSPACE, actor: user(USER), userId: USER, action: 'goal.created', category: 'command', goalId: FOREIGN_GOAL, occurredAt: at(10) }),
    makeEvent({ workspaceId: FOREIGN_WORKSPACE, actor: { type: 'brain', id: 'brain' }, action: 'campaign.created', category: 'command', goalId: FOREIGN_GOAL, campaignId: 'cmp_foreign', occurredAt: at(11) }),
    makeEvent({ workspaceId: FOREIGN_WORKSPACE, traceId: TRACE_FOREIGN, spanId: span(1), actor: user(USER), action: 'goal.updated', category: 'command', occurredAt: at(12) }),
    // A campaign with no goal at all.
    makeEvent({ actor: { type: 'system', id: 'sync' }, action: 'campaign.synced', category: 'metrics', campaignId: 'cmp_unowned', occurredAt: at(13) }),
  ];
  await h.store.appendBatch(chainAll(events));
  // Events that carry raw text (the digest is stored on the event, the text in the content store).
  const withText = await seedWithContent(h, [
    { event: { actor: user(USER), action: 'thread.message_received', category: 'command', goalId: GOAL, occurredAt: at(14) }, content: buildAuditContent('user_message', SECRET_TEXT) },
    { event: { actor: user(OTHER_USER), action: 'thread.message_received', category: 'command', goalId: OTHER_GOAL, occurredAt: at(15) }, content: buildAuditContent('user_message', 'canary text of somebody else') },
  ]);
  ownEventWithText = withText[0].eventId;
  ownEvents = [...events.filter((e) => e.actor.id === USER && e.workspaceId === WORKSPACE).map((e) => e.eventId), withText[0].eventId];
  canaryEvents = [
    ...events.filter((e) => e.actor.id !== USER || e.workspaceId !== WORKSPACE).map((e) => e.eventId),
    withText[1].eventId,
  ];

  await h.metrics.upsertObservations(WORKSPACE, [
    makeObservation({ campaignId: 'cmp_own', metrics: { impressions: 1000, clicks: 10, spend: 5, conversions: 1 } }),
    makeObservation({ campaignId: 'cmp_other', metrics: { impressions: 7000, clicks: 70, spend: 35, conversions: 7 } }),
    makeObservation({ campaignId: 'cmp_unowned', metrics: { impressions: 900000, clicks: 9, spend: 900, conversions: 9 } }),
  ]);
  await h.metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'hour', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
  await h.metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'day', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
});
afterAll(async () => {
  await h.close();
});

const idsOf = (body: any): string[] => body.events.map((e: any) => e.eventId);
const RANGE = 'from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z&granularity=hour';

describe('context-reader: authentication', () => {
  it('needs a bridge token', async () => {
    const none = await h.asContextReader('/v1/events', { service: null });
    expect(none.status).toBe(401);
    expect(none.body.error).toBe('missing_token');
    for (const service of ['garbage', await h.signers.mintServiceToken({ iss: 'proba-hub' }), await h.signers.mintServiceToken({ aud: 'proba-memory' })]) {
      expect((await h.asContextReader('/v1/events', { service })).status).toBe(401);
    }
  });

  it('refuses expired tokens, tokens that live too long, and tokens signed by the Hub key', async () => {
    const expired = await h.asContextReader('/v1/events', { service: { iatOffset: -600, expOffset: -300 } });
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe('token_expired');
    expect((await h.asContextReader('/v1/events', { service: { ttl: 300 } })).status).toBe(401);
    const hubSigned = await h.signers.mintServiceToken({}, h.signers.hub);
    expect((await h.asContextReader('/v1/events', { service: hubSigned })).status).toBe(401);
  });

  it('a bridge token does not work as an assertion, and an assertion does not work as a bridge token', async () => {
    const assertion = await h.signers.mintAssertion();
    expect((await h.asContextReader('/v1/events', { service: assertion })).status).toBe(401);
    const serviceToken = await h.signers.mintServiceToken();
    const res = await h.asContextReader('/v1/events', { assertion: serviceToken });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('act_as_invalid');
  });

  it('is off unless enabled: the same token is just an unknown token', async () => {
    const off = await createHarness();
    try {
      const token = await off.signers.mintServiceToken();
      const res = await off.get('/v1/events', token, { 'x-act-as': await off.signers.mintAssertion() });
      expect(res.status).toBe(401);
    } finally {
      await off.close();
    }
  });
});

describe('context-reader: the act-as assertion and the request must agree', () => {
  it('answers 400 when the assertion or either parameter is missing', async () => {
    const noAssertion = await h.asContextReader('/v1/events', { assertion: null });
    expect(noAssertion.status).toBe(400);
    expect(noAssertion.body.error).toBe('act_as_required');
    for (const query of [{ actorId: null }, { workspaceId: null }, { actorId: null, workspaceId: null }] as const) {
      const res = await h.asContextReader('/v1/events', { actorId: USER, query });
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error).toBe('act_as_scope_required');
    }
    expect((await h.asContextReader('/v1/events', { actorId: USER, query: false })).status).toBe(400);
    expect((await h.asContextReader('/v1/events', { actorId: USER, query: { actorId: '' } })).status).toBe(400);
  });

  it('answers 403 when actorId or workspaceId differ from the assertion', async () => {
    const otherUser = await h.asContextReader('/v1/events', { actorId: USER, query: { actorId: OTHER_USER } });
    expect(otherUser.status).toBe(403);
    expect(otherUser.body.error).toBe('act_as_mismatch');
    const otherWorkspace = await h.asContextReader('/v1/events', { actorId: USER, query: { workspaceId: FOREIGN_WORKSPACE } });
    expect(otherWorkspace.status).toBe(403);
    expect(otherWorkspace.body.error).toBe('act_as_mismatch');
    // Nothing of the other user is in a refusal, and nothing was read.
    expect(JSON.stringify(otherUser.body)).not.toContain(OTHER_USER);
  });

  it('answers 403 for an assertion that is not for this API, expired, from another issuer or signed with another key', async () => {
    const cases: [string, Parameters<Harness['signers']['mintAssertion']>[0], string][] = [
      ['audience', { sub: USER, aud: ['proba-context', 'proba-memory'] }, 'act_as_invalid'],
      ['issuer', { sub: USER, iss: 'proba-context' }, 'act_as_invalid'],
      ['expired', { sub: USER, iatOffset: -600, expOffset: -300 }, 'act_as_expired'],
      ['not yet valid', { sub: USER, nbfOffset: 600 }, 'act_as_invalid'],
      ['too long', { sub: USER, ttl: 600 }, 'act_as_invalid'],
      ['claims', { sub: USER, goalId: 'not-a-uuid' }, 'act_as_invalid'],
    ];
    for (const [name, options, code] of cases) {
      const res = await h.asContextReader('/v1/events', { actorId: USER, assertion: options });
      expect(res.status, name).toBe(403);
      expect(res.body.error, name).toBe(code);
    }
    const bridgeKey = await h.signers.mintAssertion({ sub: USER }, h.signers.service);
    expect((await h.asContextReader('/v1/events', { actorId: USER, assertion: bridgeKey })).status).toBe(403);
  });

  it('accepts up to 30 seconds of clock skew on the assertion', async () => {
    const res = await h.asContextReader('/v1/events', { actorId: USER, assertion: { iatOffset: -60, expOffset: -10 } });
    expect(res.status).toBe(200);
  });
});

describe('context-reader: routes', () => {
  it('is refused on every route outside the allowed list, even with valid credentials', async () => {
    const eventId = ownEventWithText;
    const refused = [
      `/v1/events/${eventId}/content`,
      `/v1/traces/${TRACE_OWN}/content`,
      '/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z',
      '/v1/facets',
      '/v1/session',
    ];
    for (const url of refused) {
      const res = await h.asContextReader(url, { actorId: USER });
      expect(res.status, url).toBe(403);
      expect(res.body.error, url).toBe('insufficient_role');
      expect(JSON.stringify(res.body)).not.toContain(SECRET_TEXT);
    }
    // The route is decided before anything about the user: no assertion is needed to be refused.
    expect((await h.asContextReader(`/v1/events/${eventId}/content`, { assertion: null })).status).toBe(403);
    // ...and a viewer or admin still gets what it always got.
    expect((await h.get('/v1/session')).status).toBe(200);
    expect((await h.get(`/v1/events/${eventId}/content`, TOKENS.admin)).status).toBe(200);
  });

  it('answers 404 on unknown routes and refuses non-GET methods', async () => {
    expect((await h.asContextReader('/v1/nothing', { actorId: USER })).status).toBe(404);
    const post = await h.app.inject({ method: 'POST', url: '/v1/events', headers: { authorization: `Bearer ${await h.signers.mintServiceToken()}` }, payload: {} });
    expect(post.statusCode).toBe(404);
  });
});

describe('context-reader: events', () => {
  it('returns only the acting user\'s events in the workspace, newest first', async () => {
    const res = await h.asContextReader('/v1/events?limit=100', { actorId: USER });
    expect(res.status).toBe(200);
    expect(new Set(idsOf(res.body))).toEqual(new Set(ownEvents));
    for (const id of canaryEvents) expect(idsOf(res.body)).not.toContain(id);
    for (const e of res.body.events) {
      expect(e.actor.id).toBe(USER);
      expect(e.workspaceId).toBe(WORKSPACE);
    }
    const times = res.body.events.map((e: any) => e.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('never returns raw text, its digest or a hint that text exists', async () => {
    const res = await h.asContextReader('/v1/events?limit=100', { actorId: USER });
    for (const e of res.body.events) {
      expect(e).not.toHaveProperty('content');
      expect(e).not.toHaveProperty('contentDigest');
      expect(e).not.toHaveProperty('hasContent');
    }
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TEXT);
    const withText = (await h.store.search({ workspaceId: WORKSPACE, actorId: USER, limit: 100 })).events.find((e) => e.contentDigest);
    expect(withText).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain(withText!.contentDigest as string);
    const one = await h.asContextReader(`/v1/events/${withText!.eventId}`, { actorId: USER });
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('contentDigest');
    expect(one.body).not.toHaveProperty('hasContent');
    expect(JSON.stringify(one.body)).not.toContain(SECRET_TEXT);
    // An administrator reading the same event still sees the digest.
    expect((await h.get(`/v1/events/${withText!.eventId}`, TOKENS.admin)).body.contentDigest).toBe(withText!.contentDigest);
  });

  it('filters by goal, action prefix and since', async () => {
    const byGoal = await h.asContextReader(`/v1/events?goalId=${GOAL}`, { actorId: USER });
    expect(byGoal.body.events.length).toBeGreaterThan(0);
    for (const e of byGoal.body.events) expect(e.goalId).toBe(GOAL);
    // Somebody else's goal gives this user nothing.
    expect((await h.asContextReader(`/v1/events?goalId=${OTHER_GOAL}`, { actorId: USER })).body.events).toEqual([]);

    const byPrefix = await h.asContextReader('/v1/events?actionPrefix=goal.', { actorId: USER });
    expect(byPrefix.body.events.map((e: any) => e.action).sort()).toEqual(['goal.created', 'goal.updated']);
    expect((await h.asContextReader('/v1/events?actionPrefix=goal', { actorId: USER })).body.events.length).toBe(2);
    expect((await h.asContextReader('/v1/events?actionPrefix=oal.', { actorId: USER })).body.events).toEqual([]);

    const since = await h.asContextReader(`/v1/events?since=${encodeURIComponent(at(3))}`, { actorId: USER });
    expect(since.body.events.every((e: any) => Date.parse(e.occurredAt) >= Date.parse(at(3)))).toBe(true);
    expect(since.body.events.length).toBeGreaterThan(0);
    expect(since.body.from).toBe(at(3));
  });

  it('pages with a limit and a cursor, and caps the limit', async () => {
    const first = await h.asContextReader('/v1/events?limit=2', { actorId: USER });
    expect(first.body.events).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await h.asContextReader(`/v1/events?limit=100&cursor=${first.body.nextCursor}`, { actorId: USER });
    expect(new Set([...idsOf(first.body), ...idsOf(second.body)])).toEqual(new Set(ownEvents));
    const tooMany = await h.asContextReader(`/v1/events?limit=${API_LIMITS.contextReader.maxPageSize + 1}`, { actorId: USER });
    expect(tooMany.status).toBe(400);
    expect((await h.asContextReader(`/v1/events?limit=${API_LIMITS.contextReader.maxPageSize}`, { actorId: USER })).status).toBe(200);
    expect((await h.asContextReader('/v1/events', { actorId: USER })).body.limit).toBe(API_LIMITS.contextReader.defaultPageSize);
  });

  it('refuses the filters of the other roles: no other actor, no text search, no scope', async () => {
    for (const q of ['actor=' + OTHER_USER, 'q=secret', 'threadId=' + randomUUID(), 'campaignId=cmp_other', 'from=2026-10-25T00:00:00Z']) {
      const res = await h.asContextReader(`/v1/events?${q}`, { actorId: USER });
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBe('invalid_query');
    }
    // The acting user cannot be swapped by repeating the parameter.
    expect((await h.get(`/v1/events?actorId=${USER}&workspaceId=${WORKSPACE}`)).status).toBe(400);
  });

  it('returns nothing of the workspace when the assertion is for another workspace', async () => {
    const res = await h.asContextReader('/v1/events?limit=100', { actorId: USER, workspaceId: FOREIGN_WORKSPACE });
    expect(res.status).toBe(200);
    expect(res.body.events.every((e: any) => e.workspaceId === FOREIGN_WORKSPACE)).toBe(true);
    for (const id of ownEvents) expect(idsOf(res.body)).not.toContain(id);
    const nobody = await h.asContextReader('/v1/events?limit=100', { actorId: randomUUID() });
    expect(nobody.body.events).toEqual([]);
  });

  it('one event: only the acting user\'s own, never another user\'s or another workspace\'s', async () => {
    const own = await h.asContextReader(`/v1/events/${ownEvents[0]}`, { actorId: USER });
    expect(own.status).toBe(200);
    expect(own.body.actor.id).toBe(USER);
    for (const id of canaryEvents) {
      const res = await h.asContextReader(`/v1/events/${id}`, { actorId: USER });
      expect(res.status, id).toBe(404);
    }
    expect((await h.asContextReader(`/v1/events/${randomUUID()}`, { actorId: USER })).status).toBe(404);
    expect((await h.asContextReader('/v1/events/not-a-uuid', { actorId: USER })).status).toBe(400);
    expect((await h.asContextReader(`/v1/events/${ownEvents[0]}?limit=5`, { actorId: USER })).status).toBe(400);
  });
});

describe('context-reader: traces', () => {
  it('lists only traces whose root actor is the acting user', async () => {
    const res = await h.asContextReader('/v1/traces', { actorId: USER });
    expect(res.status).toBe(200);
    const ids = res.body.traces.map((t: any) => t.traceId);
    expect(ids).toContain(TRACE_OWN);
    expect(ids).not.toContain(TRACE_OTHER); // USER appears in it, but did not start it
    expect(ids).not.toContain(TRACE_FOREIGN);
    const other = await h.asContextReader('/v1/traces', { actorId: OTHER_USER });
    expect(other.body.traces.map((t: any) => t.traceId)).toContain(TRACE_OTHER);
    expect(other.body.traces.map((t: any) => t.traceId)).not.toContain(TRACE_OWN);
  });

  it('pages and caps the limit', async () => {
    expect((await h.asContextReader(`/v1/traces?limit=${API_LIMITS.contextReaderTraces.maxPageSize + 1}`, { actorId: USER })).status).toBe(400);
    const page = await h.asContextReader('/v1/traces?limit=1', { actorId: USER });
    expect(page.body.traces.length).toBeLessThanOrEqual(1);
    expect(page.body.limit).toBe(1);
  });

  it('shows a trace only when its root actor is the acting user, and masks the other actors in it', async () => {
    const own = await h.asContextReader(`/v1/traces/${TRACE_OWN}`, { actorId: USER });
    expect(own.status).toBe(200);
    expect(own.body.eventCount).toBe(2);
    const [root] = own.body.roots;
    expect(root.actor.id).toBe(USER);
    expect(root.children[0].actor.id).toMatch(/^actor_[0-9a-f]{16}$/);
    expect(JSON.stringify(own.body)).not.toContain('brain-7');
    for (const id of [TRACE_OTHER, TRACE_FOREIGN, randomUUID()]) {
      expect((await h.asContextReader(`/v1/traces/${id}`, { actorId: USER })).status, id).toBe(404);
    }
    expect((await h.asContextReader(`/v1/traces/${TRACE_OTHER}`, { actorId: OTHER_USER })).status).toBe(200);
  });
});

describe('context-reader: analytics', () => {
  it('sums only the campaigns of goals the acting user owns', async () => {
    const summary = await h.asContextReader(`/v1/analytics/summary?${RANGE}`, { actorId: USER });
    expect(summary.status).toBe(200);
    expect(summary.body.totals).toHaveLength(1);
    expect(summary.body.totals[0]).toMatchObject({ impressions: 1000, clicks: 10, spend: 5 });
    expect(summary.body.campaigns.map((c: any) => c.campaignId)).toEqual(['cmp_own']);
    const other = await h.asContextReader(`/v1/analytics/summary?${RANGE}`, { actorId: OTHER_USER });
    expect(other.body.totals[0]).toMatchObject({ impressions: 7000, spend: 35 });
    expect(other.body.campaigns.map((c: any) => c.campaignId)).toEqual(['cmp_other']);
    // A viewer sees everything of the workspace's accounts.
    expect((await h.get(`/v1/analytics/summary?${RANGE}`)).body.campaigns).toHaveLength(3);
  });

  it('finds nothing when the query names somebody else\'s campaign, and for a user who owns none', async () => {
    for (const campaignId of ['cmp_other', 'cmp_unowned', 'cmp_foreign']) {
      const res = await h.asContextReader(`/v1/analytics/summary?${RANGE}&campaignId=${campaignId}`, { actorId: USER });
      expect(res.status, campaignId).toBe(200);
      expect(res.body.totals, campaignId).toEqual([]);
    }
    expect((await h.asContextReader(`/v1/analytics/summary?${RANGE}&campaignId=cmp_own`, { actorId: USER })).body.totals[0].impressions).toBe(1000);
    const nobody = await h.asContextReader(`/v1/analytics/summary?${RANGE}`, { actorId: randomUUID() });
    expect(nobody.body.totals).toEqual([]);
    expect(nobody.body.campaigns).toEqual([]);
  });

  it('compare and campaigns are scoped the same way', async () => {
    const compare = await h.asContextReader('/v1/analytics/compare?currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-26T00:00:00Z', { actorId: USER });
    expect(compare.status).toBe(200);
    expect(compare.body.current.totals[0]).toMatchObject({ impressions: 1000 });
    const campaigns = await h.asContextReader('/v1/analytics/campaigns?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z', { actorId: USER });
    expect(campaigns.status).toBe(200);
    expect(campaigns.body.campaigns.map((c: any) => c.campaignId)).toEqual(['cmp_own']);
  });

  it('a user of another workspace owns nothing here', async () => {
    const res = await h.asContextReader(`/v1/analytics/summary?${RANGE}`, { actorId: USER, workspaceId: FOREIGN_WORKSPACE });
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual([]);
  });
});

describe('context-reader: the audit trail of its own reads', () => {
  it('records each read under the bridge with the assertion id, and no data', async () => {
    await h.emitted();
    const assertion = await h.signers.mintAssertion({ sub: USER, jti: 'assertion-jti-777' });
    const service = await h.signers.mintServiceToken({ jti: 'service-jti-888' });
    const calls = [
      `/v1/events?goalId=${GOAL}`,
      `/v1/events/${ownEvents[0]}`,
      '/v1/traces',
      `/v1/traces/${TRACE_OWN}`,
      `/v1/analytics/summary?${RANGE}`,
      '/v1/analytics/compare?currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-26T00:00:00Z',
    ];
    for (const url of calls) expect((await h.asContextReader(url, { actorId: USER, assertion, service })).status, url).toBe(200);
    const reads = (await h.emitted()).filter((e) => e.category === 'data_access');
    expect(reads.map((e) => e.action).sort()).toEqual(
      ['analytics.compared', 'analytics.queried', 'audit.event_viewed', 'audit.searched', 'audit.searched', 'audit.trace_viewed'].sort()
    );
    for (const e of reads) {
      expect(e.actor).toEqual({ type: 'service', id: 'context-reader' });
      expect(e.userId).toBe(USER);
      expect(e.workspaceId).toBe(WORKSPACE);
      expect(e.details).toMatchObject({ caller: 'context-reader', assertionJti: 'assertion-jti-777', tokenJti: 'service-jti-888' });
      const text = JSON.stringify(e);
      expect(text).not.toContain(SECRET_TEXT);
      expect(text).not.toContain('cmp_own');
      expect(text).not.toContain('impressions');
      expect(text).not.toContain(assertion);
      expect(text).not.toContain(service);
    }
    // Their own audit events are not the user's events: a later read does not return them.
    const after = await h.asContextReader('/v1/events?limit=100', { actorId: USER });
    expect(after.body.events.every((e: any) => e.category !== 'data_access')).toBe(true);
  });

  it('records denials with the caller and, once known, the assertion id', async () => {
    // A harness of its own: the audit trail keeps only a few denials per reason and client address per minute.
    const own = await createHarness({ contextReader: true });
    try {
      await denials(own);
    } finally {
      await own.close();
    }
  });

  const denials = async (h: Harness): Promise<void> => {
    const assertion = await h.signers.mintAssertion({ sub: USER, jti: 'assertion-jti-999' });
    const res = await h.asContextReader('/v1/events', { actorId: USER, assertion, query: { actorId: OTHER_USER } });
    expect(res.status).toBe(403);
    expect((await h.asContextReader(`/v1/events/${ownEvents[0]}/content`, { actorId: USER })).status).toBe(403);
    expect((await h.asContextReader('/v1/events', { actorId: USER, assertion: null })).status).toBe(400);
    expect((await h.asContextReader('/v1/events', { actorId: USER, assertion: { aud: ['proba-memory'] } })).status).toBe(403);
    expect((await h.asContextReader('/v1/events', { actorId: USER, query: { workspaceId: null } })).status).toBe(400);
    const denied = (await h.emitted()).filter((e) => e.action === 'auth.denied');
    expect(denied.map((e) => e.errorCode).sort()).toEqual(['act_as_invalid', 'act_as_mismatch', 'act_as_required', 'act_as_scope_required', 'insufficient_role']);
    for (const e of denied) {
      expect(e.actor).toEqual({ type: 'service', id: 'context-reader' });
      expect(e.outcome).toBe('denied');
      expect(e.details).toMatchObject({ caller: 'context-reader', verifier: 'context-service' });
      expect(e.details).toHaveProperty('tokenJti');
    }
    expect(denied.find((e) => e.errorCode === 'act_as_mismatch')!.details).toMatchObject({ assertionJti: 'assertion-jti-999' });
    expect(JSON.stringify(denied)).not.toContain(OTHER_USER);
  };

  it('refuses the read when its audit event cannot be sent (fails closed)', async () => {
    const strict = await createHarness({
      contextReader: true,
      emitter: () => ({ emit: async () => Promise.reject(new Error('bus down')), forTrace() { return this; } }) as any,
    });
    try {
      const res = await strict.asContextReader('/v1/events', { actorId: USER });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('bus down');
    } finally {
      await strict.close();
    }
  });
});

describe('context-reader: rate limit and other roles', () => {
  it('limits each acting user on their own', async () => {
    const limited = await createHarness({ contextReader: true, env: { AUDIT_API_RATE_LIMIT_MAX: '2' } });
    try {
      const a = randomUUID();
      const b = randomUUID();
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await limited.asContextReader('/v1/events', { actorId: a })).status);
      expect(statuses).toEqual([200, 200, 429]);
      expect((await limited.asContextReader('/v1/events', { actorId: b })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('leaves viewers and administrators as they were', async () => {
    // A viewer cannot use the bridge parameters, and an assertion header means nothing to it.
    const withParams = await h.get(`/v1/events?actorId=${USER}&workspaceId=${WORKSPACE}`);
    expect(withParams.status).toBe(400);
    const withHeader = await h.get('/v1/events?limit=100', TOKENS.viewer, { 'x-act-as': await h.signers.mintAssertion({ sub: USER }) });
    expect(withHeader.status).toBe(200);
    // Viewers still see everybody's events, pseudonymised; administrators still see real ids and the digest.
    const viewer = await h.get('/v1/events?limit=200&actionPrefix=');
    expect(viewer.status).toBe(400);
    const list = await h.get('/v1/events?limit=200');
    expect(list.body.events.every((e: any) => !(e.actor.id === USER || e.actor.id === OTHER_USER))).toBe(true);
    expect(new Set(list.body.events.map((e: any) => e.actor.id)).size).toBeGreaterThan(1);
    const admin = await h.get('/v1/events?limit=200', TOKENS.admin);
    expect(admin.body.events.some((e: any) => e.actor.id === USER)).toBe(true);
    expect(admin.body.events.some((e: any) => e.contentDigest)).toBe(true);
    expect((await h.get('/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.admin)).status).toBe(200);
    expect((await h.get('/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.viewer)).status).toBe(403);
  });
});
