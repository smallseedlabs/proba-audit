/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
/**
 * Example requests and responses of the `context-reader` role, kept in docs/contracts/context-reader/*.json for the context bridge
 * (and anybody else who calls the role) to build against. They are produced from what the server really answers and this test
 * fails when a file no longer matches: regenerate them with
 *
 *   UPDATE_CONTRACT_FIXTURES=1 npm test -- contract-fixtures
 *
 * and commit the result. Every response body is also validated against docs/openapi.yaml, and the claims examples against the
 * protocol's act-as schema.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actAsAssertionClaimsSchema } from '@smallseedlabs/proba-protocol';
import { buildAuditContent, type AuditEvent } from '@smallseedlabs/proba-audit-core';
import { WORKSPACE, chainAll, createHarness, makeEvent, makeObservation, seedWithContent, type Harness } from './harness.testing.js';

const nodeRequire = createRequire(import.meta.url);
type Validate = ((data: unknown) => boolean) & { errors?: unknown };
type AjvInstance = { addSchema(schema: object): unknown; compile(schema: object): Validate };
const Ajv2020 = nodeRequire('ajv/dist/2020').default as new (options: object) => AjvInstance;
const addFormats = nodeRequire('ajv-formats').default as (ajv: AjvInstance) => unknown;

const DIR = fileURLToPath(new URL('../../../docs/contracts/context-reader/', import.meta.url));
const doc: any = yaml.load(readFileSync(fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi', ...doc });
const validator = (name: string) => ajv.compile({ $ref: `openapi#/components/schemas/${name}` });

const UPDATE = process.env.UPDATE_CONTRACT_FIXTURES === '1';
const TRACE_ID_IN_BODIES = '00000000-0000-4000-8000-000000000000';

const USER = '660e8400-e29b-41d4-a716-446655440001';
const OTHER_USER = '660e8400-e29b-41d4-a716-446655440009';
const GOAL = '770e8400-e29b-41d4-a716-446655440002';
const OTHER_GOAL = '770e8400-e29b-41d4-a716-446655440008';
const THREAD = '880e8400-e29b-41d4-a716-446655440003';
const TRACE = '990e8400-e29b-41d4-a716-446655440004';
const OTHER_TRACE = '990e8400-e29b-41d4-a716-446655440007';
const id = (n: number) => `aa0e8400-e29b-41d4-a716-${n.toString(16).padStart(12, '0')}`;
const span = (n: number) => `c${n.toString(16).padStart(15, '0')}`;
const at = (minutes: number) => new Date(Date.parse('2026-10-25T10:00:00.000Z') + minutes * 60_000).toISOString();
const person = (who: string) => ({ type: 'user' as const, id: who });
const RANGE = { from: '2026-10-25T00:00:00Z', to: '2026-10-26T00:00:00Z' };

let h: Harness;
let withText: string;

beforeAll(async () => {
  h = await createHarness({ contextReader: true, env: { AUDIT_CONTENT_ENABLED: 'true' } });
  const events: AuditEvent[] = [
    makeEvent({ eventId: id(1), traceId: id(101), spanId: span(1), actor: person(USER), userId: USER, action: 'goal.created', category: 'command', goalId: GOAL, threadId: THREAD, target: { type: 'goal', id: GOAL }, occurredAt: at(0), details: { source: 'portal' } }),
    makeEvent({ eventId: id(2), traceId: id(102), spanId: span(1), actor: { type: 'brain', id: 'brain' }, action: 'campaign.created', category: 'command', goalId: GOAL, campaignId: 'cmp_1001', occurredAt: at(2) }),
    makeEvent({ eventId: id(3), traceId: TRACE, spanId: span(1), actor: person(USER), action: 'goal.updated', category: 'command', goalId: GOAL, threadId: THREAD, occurredAt: at(3), durationMs: 12 }),
    makeEvent({ eventId: id(4), traceId: TRACE, spanId: span(2), parentSpanId: span(1), actor: { type: 'brain', id: 'brain-7' }, action: 'brain.reply_generated', category: 'brain', goalId: GOAL, occurredAt: at(4), durationMs: 850 }),
    makeEvent({ eventId: id(5), traceId: id(105), spanId: span(1), actor: person(OTHER_USER), userId: OTHER_USER, action: 'goal.created', category: 'command', goalId: OTHER_GOAL, occurredAt: at(5) }),
    makeEvent({ eventId: id(6), traceId: id(106), spanId: span(1), actor: { type: 'brain', id: 'brain' }, action: 'campaign.created', category: 'command', goalId: OTHER_GOAL, campaignId: 'cmp_2002', occurredAt: at(6) }),
    makeEvent({ eventId: id(7), traceId: OTHER_TRACE, spanId: span(1), actor: person(OTHER_USER), action: 'goal.updated', category: 'command', goalId: OTHER_GOAL, occurredAt: at(7) }),
  ];
  await h.store.appendBatch(chainAll(events));
  const [text] = await seedWithContent(h, [
    { event: { eventId: id(8), traceId: id(108), spanId: span(1), actor: person(USER), action: 'thread.message_received', category: 'command', goalId: GOAL, threadId: THREAD, occurredAt: at(8) }, content: buildAuditContent('user_message', 'Launch the spring campaign on Friday') },
  ]);
  withText = text.eventId;
  await h.metrics.upsertObservations(WORKSPACE, [
    makeObservation({ campaignId: 'cmp_1001', metrics: { impressions: 12000, clicks: 240, spend: 96.5, conversions: 12 } }),
    makeObservation({ campaignId: 'cmp_2002', metrics: { impressions: 50000, clicks: 500, spend: 410, conversions: 30 } }),
  ]);
  await h.metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'hour', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
});
afterAll(async () => {
  await h.close();
});

interface Recorded {
  description: string;
  request: { method: 'GET'; path: string; query: Record<string, string>; headers: Record<string, string> };
  response: { status: number; body: unknown };
}

const HEADERS = { Authorization: 'Bearer <service token>', 'X-Act-As': '<act-as assertion>' };

/** Call the server as the bridge would and describe the exchange; `query` is everything after actorId and workspaceId. */
async function exchange(
  description: string,
  path: string,
  query: Record<string, string>,
  options: Parameters<Harness['asContextReader']>[1] = {},
  headers: Record<string, string> = HEADERS
): Promise<Recorded & { schema?: string }> {
  const search = new URLSearchParams(query).toString();
  const res = await h.asContextReader(search ? `${path}?${search}` : path, { actorId: USER, ...options });
  const body = JSON.parse(JSON.stringify(res.body, (key, value) => (key === 'traceId' && typeof value === 'string' && value === res.headers['x-trace-id'] ? TRACE_ID_IN_BODIES : value)));
  const shown: Record<string, string> = {};
  if (options.query !== false) {
    shown.actorId = options.query?.actorId ?? USER;
    shown.workspaceId = options.query?.workspaceId ?? WORKSPACE;
  }
  return { description, request: { method: 'GET', path, query: { ...shown, ...query }, headers }, response: { status: res.status, body } };
}

const cases: { file: string; schema?: string; run: () => Promise<Recorded> }[] = [
  {
    file: 'events-list.json',
    schema: 'EventsPage',
    run: () => exchange('The user\'s own events whose action starts with goal., newest first. Never raw text, contentDigest or hasContent.', '/v1/events', { actionPrefix: 'goal.', limit: '10', since: '2026-10-25T00:00:00Z' }),
  },
  {
    file: 'event-get.json',
    schema: 'StoredAuditEvent',
    run: () => exchange('One of the user\'s events that has raw text elsewhere: the answer carries no text, digest or hint of it.', `/v1/events/${withText}`, {}),
  },
  {
    file: 'traces-list.json',
    schema: 'TracesPage',
    run: () => exchange('Traces the user started (their root event is theirs).', '/v1/traces', { since: '2026-10-25T00:00:00Z', limit: '10' }),
  },
  {
    file: 'trace-get.json',
    schema: 'TraceTree',
    run: () => exchange('A trace the user started, as a span tree. Actors other than the user have pseudonymous ids.', `/v1/traces/${TRACE}`, {}),
  },
  {
    file: 'analytics-summary.json',
    schema: 'MetricsSummary',
    run: () => exchange('Totals and series of the campaigns of the goals the user owns.', '/v1/analytics/summary', { ...RANGE, granularity: 'hour' }),
  },
  {
    file: 'analytics-compare.json',
    schema: 'PeriodComparison',
    run: () => exchange('Two periods side by side, for the user\'s campaigns.', '/v1/analytics/compare', { currentFrom: '2026-10-25T00:00:00Z', currentTo: '2026-10-26T00:00:00Z', granularity: 'hour' }),
  },
  {
    file: 'analytics-campaigns.json',
    schema: 'CampaignsResponse',
    run: () => exchange('The user\'s campaigns by spend.', '/v1/analytics/campaigns', { ...RANGE, granularity: 'hour' }),
  },
  {
    file: 'error-act-as-required.json',
    schema: 'Error',
    run: () => exchange('No X-Act-As assertion.', '/v1/events', {}, { assertion: null }, { Authorization: HEADERS.Authorization }),
  },
  {
    file: 'error-scope-required.json',
    schema: 'Error',
    run: () => exchange('actorId and workspaceId are missing from the query.', '/v1/events', {}, { query: false }),
  },
  {
    file: 'error-scope-mismatch.json',
    schema: 'Error',
    run: () => exchange('actorId differs from the assertion\'s sub: refused, nothing is read.', '/v1/events', {}, { query: { actorId: OTHER_USER } }),
  },
  {
    file: 'error-assertion-invalid.json',
    schema: 'Error',
    run: () => exchange('The assertion is not addressed to proba-audit.', '/v1/events', {}, { assertion: { aud: ['proba-context', 'proba-memory'] } }),
  },
  {
    file: 'error-route-not-allowed.json',
    schema: 'Error',
    run: () => exchange('Raw text is never served to this role.', `/v1/events/${withText}/content`, {}),
  },
  {
    file: 'error-event-of-another-user.json',
    schema: 'Error',
    run: () => exchange('An event of another user is answered as if it did not exist.', `/v1/events/${id(5)}`, {}),
  },
];

const EXPECTED_STATUS: Record<string, number> = {
  'error-act-as-required.json': 400,
  'error-scope-required.json': 400,
  'error-scope-mismatch.json': 403,
  'error-assertion-invalid.json': 403,
  'error-route-not-allowed.json': 403,
  'error-event-of-another-user.json': 404,
};

const claims = {
  'service-token.claims.json': {
    description: 'Claims of the bridge\'s service token (EdDSA; header carries the kid of a key in CONTEXT_SERVICE_PUBLIC_KEY_FILE). exp is at most 120 seconds after iat.',
    header: { alg: 'EdDSA', typ: 'JWT', kid: 'bridge-key-1' },
    claims: { iss: 'proba-context', aud: 'proba-audit', sub: 'context-reader', iat: 1761386400, exp: 1761386460, jti: 'f3a9c1d0-5b7e-4a52-9d59-2d1f6a0b8c11' },
  },
  'act-as-assertion.claims.json': {
    description: 'Claims of the Hub\'s act-as assertion sent as X-Act-As (EdDSA; header carries the kid of a key in HUB_ASSERTION_PUBLIC_KEY_FILE). sub and workspaceId must equal the actorId and workspaceId query parameters. exp is at most 300 seconds after iat.',
    header: { alg: 'EdDSA', typ: 'JWT', kid: 'hub-key-1' },
    claims: {
      iss: 'proba-hub',
      aud: ['proba-context', 'proba-audit'],
      sub: USER,
      workspaceId: WORKSPACE,
      goalId: GOAL,
      threadId: THREAD,
      scopes: ['context:build'],
      iat: 1761386400,
      exp: 1761386520,
      jti: '0d6b3c2e-7a41-4f6b-8a35-61c9e4d2b7a0',
    },
  },
} as const;

const read = (file: string): unknown => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8'));
const write = (file: string, value: unknown): void => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}${file}`, `${JSON.stringify(value, null, 2)}\n`);
};

describe('docs/contracts/context-reader', () => {
  for (const c of cases) {
    it(`${c.file} is what the server answers`, async () => {
      const recorded = await c.run();
      if (EXPECTED_STATUS[c.file]) expect(recorded.response.status).toBe(EXPECTED_STATUS[c.file]);
      else expect(recorded.response.status).toBe(200);
      if (c.schema) {
        const validate = validator(c.schema);
        expect(validate(recorded.response.body), JSON.stringify(validate.errors)).toBe(true);
      }
      const text = JSON.stringify(recorded.response.body);
      expect(text).not.toContain('Launch the spring campaign');
      expect(text).not.toContain('contentDigest');
      expect(text).not.toContain('hasContent');
      expect(text).not.toContain(OTHER_USER);
      expect(text).not.toContain(OTHER_GOAL);
      expect(text).not.toContain('cmp_2002');
      if (UPDATE) write(c.file, recorded);
      else expect(read(c.file)).toEqual(recorded);
    });
  }

  for (const [file, example] of Object.entries(claims)) {
    it(`${file} is what the role accepts`, () => {
      if (file.startsWith('act-as')) expect(actAsAssertionClaimsSchema.safeParse(example.claims).success).toBe(true);
      else {
        const { iat, exp } = example.claims as { iat: number; exp: number };
        expect(exp - iat).toBeLessThanOrEqual(120);
      }
      if (UPDATE) write(file, example);
      else expect(read(file)).toEqual(example);
    });
  }

  it('has no file this test does not own', () => {
    if (UPDATE) return;
    const owned = new Set([...cases.map((c) => c.file), ...Object.keys(claims)]);
    expect(readdirSync(DIR).filter((f) => f.endsWith('.json') && !owned.has(f))).toEqual([]);
  });
});
