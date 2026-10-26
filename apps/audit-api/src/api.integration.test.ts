/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * The audit API against the real services: ClickHouse (events and metrics), Redis Streams (the API's
 * own audit events) and Redis (rate limits), with real Firebase-shaped ID tokens verified against a
 * locally generated key set (no network). Every run uses its own workspace, ad account and topic, so one
 * shared stack can run all integration tests, and rows of other workspaces in the same tables prove isolation.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryLogger,
  buildAuditEvent,
  chainEvent,
  createBusAuditEmitter,
  loadConfig,
  type AuditEvent,
  type ChainLink,
  type StoredAuditEvent,
} from '@smallseedlabs/proba-audit-core';
import { uniqueName } from '@smallseedlabs/proba-audit-core/testing';
import {
  ClickHouseAuditStore,
  ClickHouseMetricsStore,
  FirebaseTokenVerifier,
  RandomIdGenerator,
  RedisRateLimiter,
  RedisStreamsEventBus,
  SystemClock,
  clickHouseMigrationDb,
  createClickHouseClient,
  createFakeFirebaseIssuer,
  ensureDatabase,
  loadMigrations,
  runMigrations,
  type ClickHouseOptions,
  type FakeFirebaseIssuer,
} from '@smallseedlabs/proba-audit-adapters';
import { buildServer } from './server.js';
import { createStaticScope } from './scope.js';
import { makeObservation } from './harness.testing.js';

const PROJECT = 'proba-integration';
const env = process.env;
const run = randomUUID().slice(0, 8);
const WORKSPACE = `ws-${run}`;
const OTHER_WORKSPACE = `ws-other-${run}`;
const ACCOUNT = `act_${run}`;
const topic = uniqueName('api-topic');
const chOptions: ClickHouseOptions = {
  ...loadConfig(env).clickhouse,
  database: env.CLICKHOUSE_TEST_DATABASE ?? 'proba_audit_test',
};
const redisUrl = loadConfig(env).eventBus.redisUrl;

const config = loadConfig(
  {
    ...env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    FIREBASE_PROJECT_ID: PROJECT,
    AUDIT_API_ALLOWED_EMAILS: 'viewer@insights.example',
    AUDIT_API_ADMIN_EMAILS: 'admin@insights.example',
    AUDIT_API_CORS_ORIGINS: 'http://localhost:5173',
    AUDIT_API_WORKSPACE_ID: WORKSPACE,
    AUDIT_API_SCOPE_SOURCE: 'static',
    AUDIT_API_ANALYTICS_ACCOUNTS: `meta:${ACCOUNT}`,
    AUDIT_API_RATE_LIMIT_MAX: '1000',
    AUDIT_API_AUTH_FAILURE_LIMIT_MAX: '1000',
    AUDIT_TOPIC: topic,
  },
  { serviceName: 'audit-api' }
);

let issuer: FakeFirebaseIssuer;
let app: FastifyInstance;
let bus: RedisStreamsEventBus;
let store: ClickHouseAuditStore;
let metrics: ClickHouseMetricsStore;
let limiter: RedisRateLimiter;
const clock = new SystemClock();
const span = (n: number) => `c${n.toString(16).padStart(15, '0')}`;

const tokens = {
  viewer: () => issuer.mint({ uid: 'uid-viewer', email: 'viewer@insights.example' }),
  admin: () => issuer.mint({ uid: 'uid-admin', email: 'admin@insights.example' }),
  outsider: () => issuer.mint({ uid: 'uid-outsider', email: 'stranger@elsewhere.example' }),
};

async function get(path: string, token?: string | null): Promise<{ status: number; body: any; headers: Record<string, any> }> {
  const bearer = token === undefined ? await tokens.viewer() : token;
  const res = await app.inject({ method: 'GET', url: path, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  let body: unknown;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, any> };
}

function chainAll(events: AuditEvent[], head: ChainLink | null = null): StoredAuditEvent[] {
  let t = Date.now() - 3_600_000;
  return events.map((e) => {
    const stored = chainEvent(e, head, new Date(t).toISOString());
    t += 1000;
    head = { hash: stored.hash, ingestedAt: stored.ingestedAt };
    return stored;
  });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ev = (over: Partial<AuditEvent>): AuditEvent =>
  buildAuditEvent({
    workspaceId: WORKSPACE,
    traceId: randomUUID(),
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
    occurredAt: minutesAgo(30),
    details: {},
    ...over,
  });

const traceA = randomUUID();
const goalA = randomUUID();

beforeAll(async () => {
  await ensureDatabase(chOptions);
  const migrationClient = createClickHouseClient(chOptions);
  await runMigrations(clickHouseMigrationDb(migrationClient), loadMigrations(resolve(__dirname, '../../../migrations/clickhouse')));
  await migrationClient.close();

  issuer = await createFakeFirebaseIssuer(PROJECT);
  store = new ClickHouseAuditStore({ client: createClickHouseClient(chOptions), ownsClient: true });
  metrics = new ClickHouseMetricsStore({ client: createClickHouseClient(chOptions), ownsClient: true, clock });
  bus = new RedisStreamsEventBus({ url: redisUrl });
  limiter = new RedisRateLimiter({ url: redisUrl, keyPrefix: `api-it:${run}:` });
  const logger = new MemoryLogger();
  const ids = new RandomIdGenerator();
  const emitterDeps = { bus, topic, service: 'audit-api', defaultWorkspaceId: WORKSPACE, clock, ids, logger };

  // Twenty-three events of this workspace (one trace with a failure, an orphan and a denial), three of another one.
  const own = [
    ev({ traceId: traceA, spanId: span(1), occurredAt: minutesAgo(40), durationMs: 20, goalId: goalA }),
    ev({ traceId: traceA, spanId: span(2), parentSpanId: span(1), occurredAt: minutesAgo(39), action: 'tool.failed', category: 'tool', outcome: 'failure', errorCode: 'TIMEOUT', riskLevel: 'high', durationMs: 1500, campaignId: 'cmp_1', target: { type: 'tool', id: 'LaunchCampaign' } }),
    ev({ traceId: traceA, spanId: span(3), parentSpanId: span(1), occurredAt: minutesAgo(38), action: 'policy.denied', category: 'policy', outcome: 'denied', riskLevel: 'medium' }),
    ev({ traceId: traceA, spanId: span(4), parentSpanId: span(8), occurredAt: minutesAgo(37), action: 'system.job_run', category: 'system' }),
    ...Array.from({ length: 19 }, (_, i) => ev({ occurredAt: minutesAgo(30 - i), action: i % 2 ? 'brain.llm_call' : 'command.received', category: i % 2 ? 'brain' : 'command', service: i % 2 ? 'brain' : 'hub' })),
  ];
  await store.appendBatch(chainAll(own));
  await store.appendBatch(chainAll([ev({ workspaceId: OTHER_WORKSPACE, action: 'command.received' }), ev({ workspaceId: OTHER_WORKSPACE }), ev({ workspaceId: OTHER_WORKSPACE })]));

  const base = new Date();
  base.setUTCMinutes(0, 0, 0);
  const hourStart = (back: number) => new Date(base.getTime() - back * 3_600_000).toISOString();
  const observations = [3, 2, 1].map((back) =>
    makeObservation({
      accountId: ACCOUNT,
      campaignId: back === 1 ? 'cmp_small' : 'cmp_big',
      periodStart: hourStart(back),
      periodEnd: hourStart(back - 1),
      metrics: { impressions: 1000 * back, clicks: 10 * back, spend: 5 * back, conversions: back },
      fetchedAt: new Date().toISOString(),
    })
  );
  await metrics.upsertObservations(WORKSPACE, [
    ...observations,
    makeObservation({ accountId: `act_foreign_${run}`, campaignId: 'cmp_foreign', periodStart: hourStart(2), periodEnd: hourStart(1), metrics: { impressions: 999999, clicks: 1, spend: 999, conversions: 1 } }),
  ]);
  const window = { from: new Date(base.getTime() - 48 * 3_600_000).toISOString(), to: new Date(base.getTime() + 3_600_000).toISOString() };
  await metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'hour', ...window });
  await metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'day', ...window });

  app = await buildServer({
    config,
    logger,
    clock,
    verifier: new FirebaseTokenVerifier({ projectId: PROJECT, keys: issuer.keys }),
    limiter,
    auditStore: store,
    metricsStore: metrics,
    scope: createStaticScope(WORKSPACE, config.api.analyticsAccounts).resolve,
    emitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'throw' }),
    bestEffortEmitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'swallow' }),
    readiness: [
      { name: 'auditStore', check: () => store.ping() },
      { name: 'metricsStore', check: () => metrics.ping() },
      { name: 'eventBus', check: () => bus.ping() },
    ],
  });
});

afterAll(async () => {
  await app?.close();
  await Promise.allSettled([limiter?.close(), store?.close(), metrics?.close(), bus?.close()]);
});

describe('audit API on ClickHouse and Redis', () => {
  it('is ready only when ClickHouse and Redis answer', async () => {
    const res = await get('/ready', null);
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ auditStore: 'ok', metricsStore: 'ok', eventBus: 'ok' });
  });

  it('accepts a real Firebase-shaped ID token, and refuses the wrong project, expiry and unlisted people', async () => {
    expect((await get('/v1/session')).body).toMatchObject({ email: 'viewer@insights.example', role: 'viewer', workspaceId: WORKSPACE });
    expect((await get('/v1/session', await issuer.mint({ email: 'admin@insights.example' }))).body.role).toBe('admin');
    expect((await get('/v1/session', await issuer.mint({ aud: 'another-project', email: 'viewer@insights.example' }))).status).toBe(401);
    expect((await get('/v1/session', await issuer.mint({ iatOffset: -7200, expOffset: -3600, email: 'viewer@insights.example' }))).status).toBe(401);
    expect((await get('/v1/session', await issuer.mint({ emailVerified: false, email: 'viewer@insights.example' }))).status).toBe(403);
    expect((await get('/v1/session', await tokens.outsider())).status).toBe(403);
    expect((await get('/v1/session', null)).status).toBe(401);
  });

  it('pages through events with a cursor, newest first, without gaps or repeats, and never shows another workspace', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/v1/events?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(5);
      for (const e of res.body.events) {
        expect(e.workspaceId).toBe(WORKSPACE);
        seen.push(e.eventId);
      }
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    const all = (await get('/v1/events?limit=200')).body.events as StoredAuditEvent[];
    const times = all.map((e) => Date.parse(e.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('filters by facet, id and free text', async () => {
    expect((await get('/v1/events?outcome=failure')).body.events).toHaveLength(1);
    expect((await get('/v1/events?riskLevel=high')).body.events[0].action).toBe('tool.failed');
    expect((await get('/v1/events?category=brain')).body.events.length).toBe(9);
    expect((await get(`/v1/events?goalId=${goalA}`)).body.events).toHaveLength(1);
    expect((await get('/v1/events?campaignId=cmp_1')).body.events).toHaveLength(1);
    expect((await get('/v1/events?q=launchcampaign')).body.events).toHaveLength(1); // case-insensitive, matches the target
    expect((await get('/v1/events?q=100%25')).body.events).toHaveLength(0); // % is literal text, not a wildcard
    expect((await get(`/v1/events?traceId=${traceA}&order=asc`)).body.events.map((e: any) => e.action)).toEqual(['command.received', 'tool.failed', 'policy.denied', 'system.job_run']);
  });

  it('returns one event, and 404 for another workspace`s event', async () => {
    const [first] = (await get('/v1/events?limit=1')).body.events;
    const one = await get(`/v1/events/${first.eventId}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ eventId: first.eventId, hash: first.hash });
    const foreign = await store.search({ workspaceId: OTHER_WORKSPACE, limit: 1 });
    expect((await get(`/v1/events/${foreign.events[0].eventId}`)).status).toBe(404);
  });

  it('builds the span tree of a trace and lists traces with summaries', async () => {
    const tree = (await get(`/v1/traces/${traceA}`)).body;
    expect(tree).toMatchObject({ traceId: traceA, eventCount: 4, outcome: 'failure', riskLevel: 'high', truncated: false });
    expect(tree.roots).toHaveLength(2); // the root, and the orphan whose parent was never stored
    expect(tree.roots[0].children.map((c: any) => c.action)).toEqual(['tool.failed', 'policy.denied']);
    expect(tree.roots.find((r: any) => r.orphan)).toBeDefined();
    expect(tree.related).toEqual({ goalIds: [goalA], threadIds: [], campaignIds: ['cmp_1'] });
    const list = (await get('/v1/traces?limit=100')).body;
    const summary = list.traces.find((t: any) => t.traceId === traceA);
    expect(summary).toMatchObject({ rootAction: 'command.received', eventCount: 4, outcome: 'failure', riskLevel: 'high' });
    expect(list.traces).toHaveLength(20); // one trace plus nineteen single-event traces
  });

  it('lists facets with counts', async () => {
    const { facets } = (await get('/v1/facets')).body;
    expect(facets.service).toEqual(expect.arrayContaining([{ value: 'hub', count: expect.any(Number) }, { value: 'brain', count: 9 }]));
    expect(facets.outcome.map((o: any) => o.value).sort()).toEqual(['denied', 'failure', 'success']);
  });

  it('verifies the workspace chain (administrators only) and sees events of this workspace only', async () => {
    const from = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const forbidden = await get(`/v1/chain/verify?from=${from}&to=${to}`);
    expect(forbidden.status).toBe(403);
    const res = await get(`/v1/chain/verify?from=${from}&to=${to}`, await tokens.admin());
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    expect(res.body).toMatchObject({ workspaceId: WORKSPACE, ok: true, checked: 23, complete: true });
    expect(res.body.truncated).toBeUndefined();
  });

  it('serves analytics for the workspace`s ad accounts only, with freshness', async () => {
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0); // hourly ranges must start and end on the hour
    const from = new Date(hour.getTime() - 24 * 3_600_000).toISOString();
    const to = new Date(hour.getTime() + 3_600_000).toISOString();
    const summary = (await get(`/v1/analytics/summary?from=${from}&to=${to}&granularity=hour`)).body;
    expect(summary.issues).toBeUndefined();
    expect(summary.totals).toEqual([expect.objectContaining({ currency: 'USD', impressions: 6000, clicks: 60, spend: 30, conversions: 6 })]);
    expect(summary.series).toHaveLength(3);
    expect(summary.campaigns.map((c: any) => c.campaignId)).toEqual(['cmp_big', 'cmp_small']);
    expect(JSON.stringify(summary)).not.toContain('cmp_foreign');
    expect(summary.freshness.asOf).toEqual(expect.any(String));
    const campaigns = (await get(`/v1/analytics/campaigns?from=${from}&to=${to}&granularity=hour&limit=1`)).body;
    expect(campaigns).toMatchObject({ truncated: true });
    expect(campaigns.campaigns).toHaveLength(1);
    const compare = await get(`/v1/analytics/compare?granularity=hour&currentFrom=${new Date(hour.getTime() - 4 * 3_600_000).toISOString()}&currentTo=${to}`);
    expect(compare.status).toBe(200);
    expect(compare.body.comparison[0].impressions.current).toBe(6000);
  });

  it('records every read in the audit stream under the response trace id, without the caller`s email or the filter values', async () => {
    const sub = await bus.subscribe({ topic, group: uniqueName('reader'), consumer: 'c1', startFrom: 'earliest' });
    try {
      const res = await get('/v1/events?q=needle-text&limit=3');
      const traceId = res.headers['x-trace-id'];
      let mine: AuditEvent | undefined;
      for (let i = 0; i < 20 && !mine; i += 1) {
        const messages = await sub.read<AuditEvent>({ max: 100, blockMs: 100 });
        mine = messages.map((m) => m.payload).find((e) => e.traceId === traceId);
        await sub.ack(messages.map((m) => m.id));
      }
      expect(mine).toMatchObject({ action: 'audit.searched', workspaceId: WORKSPACE, service: 'audit-api', actor: { type: 'user', id: 'uid-viewer' } });
      expect((mine as AuditEvent).details).toMatchObject({ operation: 'events.search', route: 'GET /v1/events' });
      expect(JSON.stringify(mine)).not.toContain('needle-text');
      expect(JSON.stringify(mine)).not.toContain('viewer@insights');
    } finally {
      await sub.close();
    }
  });

  it('limits a caller through Redis, and tells them when to retry', async () => {
    const strict = loadConfig({ ...env, NODE_ENV: 'test', LOG_LEVEL: 'silent', FIREBASE_PROJECT_ID: PROJECT, AUDIT_API_ALLOWED_EMAILS: 'viewer@insights.example', AUDIT_API_WORKSPACE_ID: WORKSPACE, AUDIT_API_SCOPE_SOURCE: 'static', AUDIT_API_RATE_LIMIT_MAX: '3', AUDIT_TOPIC: topic }, { serviceName: 'audit-api' });
    const logger = new MemoryLogger();
    const ids = new RandomIdGenerator();
    const emitterDeps = { bus, topic, service: 'audit-api', defaultWorkspaceId: WORKSPACE, clock, ids, logger };
    const limited = await buildServer({
      config: strict,
      logger,
      clock,
      verifier: new FirebaseTokenVerifier({ projectId: PROJECT, keys: issuer.keys }),
      limiter: new RedisRateLimiter({ url: redisUrl, keyPrefix: `api-it-strict:${run}:` }),
      auditStore: store,
      metricsStore: metrics,
      scope: createStaticScope(WORKSPACE, []).resolve,
      emitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'throw' }),
      bestEffortEmitter: createBusAuditEmitter({ ...emitterDeps, failureMode: 'swallow' }),
      readiness: [],
    });
    try {
      const token = await tokens.viewer();
      const statuses: number[] = [];
      let retryAfter: unknown;
      for (let i = 0; i < 5; i += 1) {
        const res = await limited.inject({ method: 'GET', url: '/v1/session', headers: { authorization: `Bearer ${token}` } });
        statuses.push(res.statusCode);
        if (res.statusCode === 429) retryAfter = res.headers['retry-after'];
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    } finally {
      await limited.close();
    }
  });
});
