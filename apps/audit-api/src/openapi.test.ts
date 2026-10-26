/* eslint-disable @typescript-eslint/no-explicit-any -- the OpenAPI document and response bodies are inspected loosely */
/**
 * Keeps docs/openapi.yaml honest: the document, the routes the server registers, the query schemas it
 * validates with, the caps in API_LIMITS and the bodies it actually returns must all agree.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuditContent, validateStoredAuditEvent } from '@smallseedlabs/proba-audit-core';
import {
  API_LIMITS,
  campaignsQuerySchema,
  chainQuerySchema,
  compareQuerySchema,
  eventsQuerySchema,
  facetsQuerySchema,
  summaryQuerySchema,
  tracesQuerySchema,
} from './http/schemas.js';
import { TOKENS, WORKSPACE, chainAll, createHarness, makeEvent, makeObservation, seedWithContent, type Harness } from './harness.testing.js';

// Both packages are CommonJS: load them the way Node does, whatever the test runner's interop.
const nodeRequire = createRequire(import.meta.url);
type Validate = ((data: unknown) => boolean) & { errors?: unknown };
type AjvInstance = { addSchema(schema: object): unknown; compile(schema: object): Validate };
const Ajv2020 = nodeRequire('ajv/dist/2020').default as new (options: object) => AjvInstance;
const addFormats = nodeRequire('ajv-formats').default as (ajv: AjvInstance) => unknown;

const doc: any = yaml.load(readFileSync(fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url)), 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const operations: { method: string; path: string; op: any }[] = Object.entries<any>(doc.paths).flatMap(([path, item]) =>
  Object.entries<any>(item)
    .filter(([m]) => METHODS.includes(m))
    .map(([method, op]) => ({ method, path, op }))
);

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi', ...doc });
const validator = (schemaName: string) => ajv.compile({ $ref: `openapi#/components/schemas/${schemaName}` });

const resolveRef = (node: any): any => {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    return node.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((acc: any, key: string) => acc[key], doc);
  }
  return node;
};

describe('docs/openapi.yaml', () => {
  it('is an OpenAPI 3.1 document with unique operation ids and a bearer scheme', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.components.securitySchemes.firebaseIdToken).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.security).toEqual([{ firebaseIdToken: [] }]);
  });

  it('describes read-only routes only', () => {
    expect(operations.every((o) => o.method === 'get')).toBe(true);
  });

  it('describes exactly the routes the server registers', async () => {
    const h = await createHarness();
    try {
      // Every documented route exists...
      for (const { method, path } of operations) {
        expect(h.app.hasRoute({ method: method.toUpperCase() as 'GET', url: path.replace(/\{(\w+)\}/g, ':$1') }), `${method} ${path}`).toBe(true);
      }
      // ...and the server registers nothing else: the routing tree lists one GET entry per documented operation
      // (HEAD is added automatically by Fastify next to each GET), and no entry for any other method
      // except the CORS preflight catch-all (OPTIONS *).
      const tree = h.app.printRoutes({ commonPrefix: false }).replace(/^.*\* \(OPTIONS\)$/m, '');
      const entries = [...tree.matchAll(/\(([A-Z, ]+)\)/g)].map((m) => m[1].split(',').map((x) => x.trim()).filter((x) => x !== 'HEAD'));
      expect(entries.every((methods) => methods.length === 1 && methods[0] === 'GET')).toBe(true);
      expect(entries).toHaveLength(operations.length);
    } finally {
      await h.close();
    }
  });

  it('keeps public routes public and every /v1 route authenticated', () => {
    for (const { path, op } of operations) {
      if (path.startsWith('/v1')) {
        expect(op.security, path).toBeUndefined();
        expect(Object.keys(op.responses), path).toEqual(expect.arrayContaining(['401', '403', '429']));
      } else {
        expect(op.security, path).toEqual([]);
      }
    }
  });
});

describe('query parameters match the validation schemas', () => {
  const schemas: Record<string, any> = {
    '/v1/events': eventsQuerySchema,
    '/v1/traces': tracesQuerySchema,
    '/v1/facets': facetsQuerySchema,
    '/v1/chain/verify': chainQuerySchema,
    '/v1/analytics/summary': summaryQuerySchema,
    '/v1/analytics/compare': compareQuerySchema,
    '/v1/analytics/campaigns': campaignsQuerySchema,
  };
  const shapeOf = (schema: any): Record<string, any> => (schema._def.schema ?? schema).shape;

  for (const [path, schema] of Object.entries(schemas)) {
    it(`${path}: same names, required flags and defaults`, () => {
      const shape = shapeOf(schema);
      const spec = doc.paths[path].get.parameters.map(resolveRef);
      expect(spec.map((p: any) => p.name).sort()).toEqual(Object.keys(shape).sort());
      for (const p of spec) {
        expect(p.in).toBe('query');
        expect(Boolean(p.required), `${path} ${p.name} required`).toBe(!shape[p.name].isOptional());
        if (p.schema.default !== undefined) expect(shape[p.name].parse(undefined), `${path} ${p.name} default`).toEqual(p.schema.default);
        if (p.schema.maximum !== undefined) {
          expect(shape[p.name].safeParse(String(p.schema.maximum)).success, `${path} ${p.name} accepts its maximum`).toBe(true);
          expect(shape[p.name].safeParse(String(p.schema.maximum + 1)).success, `${path} ${p.name} refuses above its maximum`).toBe(false);
        }
      }
    });
  }

  it('enumerations in the document are the ones the schemas accept', () => {
    const enumsOf = (name: string): string[] => resolveRef(doc.paths['/v1/events'].get.parameters.find((p: any) => p.name === name).schema).enum;
    for (const name of ['actorType', 'category', 'outcome', 'riskLevel']) {
      const values: string[] = enumsOf(name);
      expect(values.length).toBeGreaterThan(1);
      for (const v of values) expect(eventsQuerySchema.safeParse({ [name]: v }).success, `${name}=${v}`).toBe(true);
      expect(eventsQuerySchema.safeParse({ [name]: 'nonsense' }).success).toBe(false);
    }
  });

  it('page-size defaults and caps are the ones in API_LIMITS', () => {
    const limitOf = (path: string) => doc.paths[path].get.parameters.find((p: any) => p.name === 'limit').schema;
    expect(limitOf('/v1/events')).toMatchObject({ default: API_LIMITS.events.defaultPageSize, maximum: API_LIMITS.events.maxPageSize });
    expect(limitOf('/v1/traces')).toMatchObject({ default: API_LIMITS.traces.defaultPageSize, maximum: API_LIMITS.traces.maxPageSize });
    expect(limitOf('/v1/facets')).toMatchObject({ default: API_LIMITS.facets.defaultValues, maximum: API_LIMITS.facets.maxValues });
    expect(limitOf('/v1/analytics/campaigns')).toMatchObject({ default: API_LIMITS.campaigns.defaultRows, maximum: API_LIMITS.campaigns.maxRows });
  });

  it('has no workspace parameter anywhere', () => {
    for (const { op } of operations) for (const p of (op.parameters ?? []).map(resolveRef)) expect(p.name.toLowerCase()).not.toContain('workspace');
  });
});

describe('what the server returns conforms to the document', () => {
  let h: Harness;
  const traceId = randomUUID();
  const goalId = randomUUID();
  const span = (n: number) => `a${n.toString(16).padStart(15, '0')}`;

  beforeAll(async () => {
    h = await createHarness();
    const t = (s: number) => `2026-10-25T10:00:0${s}.000Z`;
    await h.store.appendBatch(
      chainAll([
        makeEvent({ traceId, spanId: span(1), occurredAt: t(0), durationMs: 10, goalId, userId: randomUUID(), cost: { tokensIn: 10, tokensOut: 5, currency: 'USD', amount: 0.01 }, tags: ['x'] }),
        makeEvent({ traceId, spanId: span(2), parentSpanId: span(1), occurredAt: t(1), action: 'tool.failed', category: 'tool', outcome: 'failure', errorCode: 'TIMEOUT', errorMessage: 'timed out', riskLevel: 'medium', target: { type: 'tool', id: 'x' }, campaignId: 'cmp_1' }),
        makeEvent({ traceId, spanId: span(3), parentSpanId: span(9), occurredAt: t(2), action: 'policy.denied', category: 'policy', outcome: 'denied' }),
        makeEvent({}),
      ])
    );
    await h.metrics.upsertObservations(WORKSPACE, [makeObservation(), makeObservation({ campaignId: 'cmp_2', metrics: { impressions: 10, clicks: 1, spend: 1, conversions: 0 } })]);
    await h.metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'hour', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
    await h.metrics.computeRollups({ workspaceId: WORKSPACE, bucket: 'day', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
  });
  afterAll(async () => {
    await h.close();
  });

  const check = (schema: string, body: unknown): void => {
    const validate = validator(schema);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  };

  it('/health and /ready', async () => {
    check('Readiness', (await h.get('/ready', null)).body);
    expect((await h.get('/health', null)).body).toMatchObject({ status: 'ok' });
  });

  it('/v1/session', async () => check('Session', (await h.get('/v1/session')).body));

  it('/v1/events (and every event is a valid protocol StoredAuditEvent)', async () => {
    const res = await h.get('/v1/events?limit=2');
    expect(res.status).toBe(200);
    check('EventsPage', res.body);
    expect(res.body.nextCursor).not.toBeNull();
    for (const e of res.body.events) expect(() => validateStoredAuditEvent(e)).not.toThrow();
    const full = await h.get(`/v1/events?traceId=${traceId}&order=asc`);
    check('EventsPage', full.body);
    for (const e of full.body.events) check('StoredAuditEvent', e);
  });

  it('/v1/events/{eventId}', async () => {
    const [first] = (await h.get(`/v1/events?traceId=${traceId}`)).body.events;
    check('StoredAuditEvent', (await h.get(`/v1/events/${first.eventId}`)).body);
  });

  it('/v1/traces and /v1/traces/{traceId}', async () => {
    const list = await h.get('/v1/traces');
    check('TracesPage', list.body);
    expect(list.body.traces.length).toBe(2);
    const tree = await h.get(`/v1/traces/${traceId}`);
    check('TraceTree', tree.body);
    expect(tree.body.eventCount).toBe(3);
  });

  it('/v1/chain/verify', async () => {
    const res = await h.get('/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.admin);
    expect(res.status).toBe(200);
    check('ChainVerification', res.body);
    expect(res.body.ok).toBe(true);
  });

  it('/v1/analytics/*', async () => {
    const summary = await h.get('/v1/analytics/summary?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z&granularity=hour');
    expect(summary.status).toBe(200);
    check('MetricsSummary', summary.body);
    expect(summary.body.series.length).toBeGreaterThan(0);
    const compare = await h.get('/v1/analytics/compare?currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-26T00:00:00Z');
    expect(compare.status).toBe(200);
    check('PeriodComparison', compare.body);
    const campaigns = await h.get('/v1/analytics/campaigns?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z');
    expect(campaigns.status).toBe(200);
    check('CampaignsResponse', campaigns.body);
    expect(campaigns.body.campaigns.length).toBe(2);
  });

  it('/v1/facets', async () => {
    const res = await h.get('/v1/facets');
    check('Facets', res.body);
    expect(res.body.facets.service.length).toBeGreaterThan(0);
  });

  it('/v1/events/{eventId}/content and /v1/traces/{traceId}/content, and events that have text', async () => {
    const withText = await createHarness({ env: { AUDIT_CONTENT_ENABLED: 'true' } });
    try {
      const tid = randomUUID();
      const [e] = await seedWithContent(withText, [{ event: { traceId: tid }, content: buildAuditContent('user_message', 'hello there') }]);
      const one = await withText.get(`/v1/events/${e.eventId}/content`, TOKENS.admin);
      expect(one.status).toBe(200);
      check('EventContent', one.body);
      const trace = await withText.get(`/v1/traces/${tid}/content`, TOKENS.admin);
      expect(trace.status).toBe(200);
      check('TraceContent', trace.body);
      for (const token of [TOKENS.viewer, TOKENS.admin]) {
        const list = await withText.get('/v1/events', token);
        check('EventsPage', list.body);
        check('StoredAuditEvent', (await withText.get(`/v1/events/${e.eventId}`, token)).body);
      }
      const verify = await withText.get('/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.admin);
      check('ChainVerification', verify.body);
      expect(verify.body.content).toEqual({ checked: 1, missing: 0 });
      // Errors on the new routes are documented too.
      for (const [url, token, status] of [
        [`/v1/events/${e.eventId}/content`, TOKENS.viewer, 403],
        [`/v1/events/${randomUUID()}/content`, TOKENS.admin, 404],
        [`/v1/traces/${randomUUID()}/content`, TOKENS.admin, 404],
        ['/v1/events/not-a-uuid/content', TOKENS.admin, 400],
      ] as [string, string, number][]) {
        const res = await withText.get(url, token);
        expect(res.status, url).toBe(status);
        check('Error', res.body);
        const key = url.includes('/traces/') ? '/v1/traces/{traceId}/content' : '/v1/events/{eventId}/content';
        expect(doc.paths[key]?.get.responses[String(status)], `${key} documents ${status}`).toBeDefined();
      }
    } finally {
      await withText.close();
    }
  });

  it('errors use the documented body, with the trace id in header and body', async () => {
    const cases: [string, string | null, number][] = [
      ['/v1/events?bogus=1', TOKENS.viewer, 400],
      ['/v1/events', null, 401],
      ['/v1/events', TOKENS.outsider, 403],
      [`/v1/events/${randomUUID()}`, TOKENS.viewer, 404],
      ['/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.viewer, 403],
    ];
    for (const [url, token, status] of cases) {
      const res = await h.get(url, token);
      expect(res.status, url).toBe(status);
      check('Error', res.body);
      expect(res.body.traceId).toBe(res.headers['x-trace-id']);
      const documented = doc.paths[url.split('?')[0].replace(/[0-9a-f-]{36}/, '{eventId}')]?.get.responses[String(status)];
      expect(documented, `${url} documents ${status}`).toBeDefined();
    }
  });
});
