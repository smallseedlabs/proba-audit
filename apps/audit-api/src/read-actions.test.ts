/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTION_INFO, AUDIT_READ_ACTIONS, buildAuditContent, getAuditActionInfo, type AuditEvent } from '@smallseedlabs/proba-audit-core';
import { TOKENS, createHarness, makeEvent, makeObservation, seedWithContent, type Harness } from './harness.testing.js';

/**
 * The API records what it reads with the protocol's specific audit.* / analytics.* actions. This scans what it really emits,
 * on every route, against the protocol catalog: every action must be catalogued, `specific` (never a generic or alias entry),
 * in the `data_access` category, and never the old `data_access.read` / `data_access.audit_*` / `data_access.metrics_*` names.
 */
describe('audit-api read actions are catalogued and specific', () => {
  let h: Harness;
  const emittedAll: AuditEvent[] = [];
  const traceId = '30000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    h = await createHarness({ env: { AUDIT_CONTENT_ENABLED: 'true' } });
    const [e] = await seedWithContent(h, [{ event: { traceId }, content: buildAuditContent('user_message', 'hello') }]);
    await h.metrics.upsertObservations([makeObservation()]);
    await h.metrics.computeRollups({ bucket: 'hour', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
    await h.metrics.computeRollups({ bucket: 'day', from: '2026-10-24T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z' });
    const day = 'from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z';
    const routes: [string, string][] = [
      ['/v1/session', TOKENS.viewer],
      ['/v1/events?limit=5', TOKENS.viewer],
      [`/v1/events/${e.eventId}`, TOKENS.viewer],
      [`/v1/events/${e.eventId}/content`, TOKENS.admin],
      ['/v1/traces', TOKENS.viewer],
      [`/v1/traces/${traceId}`, TOKENS.viewer],
      [`/v1/traces/${traceId}/content`, TOKENS.admin],
      ['/v1/facets', TOKENS.viewer],
      ['/v1/chain/verify?from=2026-10-25T09:00:00Z&to=2026-10-25T11:00:00Z', TOKENS.admin],
      [`/v1/analytics/summary?${day}`, TOKENS.viewer],
      ['/v1/analytics/compare?currentFrom=2026-10-25T00:00:00Z&currentTo=2026-10-26T00:00:00Z', TOKENS.viewer],
      [`/v1/analytics/campaigns?${day}`, TOKENS.viewer],
      // failures are audited with the same actions
      [`/v1/events/${makeEvent().eventId}`, TOKENS.viewer],
      ['/v1/analytics/summary?from=2026-10-25T00:30:00Z&to=2026-10-26T00:00:00Z&granularity=hour', TOKENS.viewer],
    ];
    for (const [url, token] of routes) await h.get(url, token);
    emittedAll.push(...(await h.emitted()));
  });
  afterAll(async () => {
    await h.close();
  });

  it('emits something for every read route except /v1/session', () => {
    expect(new Set(emittedAll.map((e) => e.action))).toEqual(
      new Set(['audit.searched', 'audit.event_viewed', 'audit.trace_viewed', 'audit.integrity_checked', 'analytics.queried', 'analytics.compared'])
    );
  });

  it('only emits catalogued, specific data_access actions', () => {
    for (const e of emittedAll) {
      const info = getAuditActionInfo(e.action);
      expect(info, `${e.action} is in the protocol catalog`).toBeDefined();
      expect(info!.status, `${e.action} is specific, not generic or alias`).toBe('specific');
      expect(e.category).toBe(info!.category);
      expect(e.category).toBe('data_access');
      expect(e.riskLevel === undefined || e.riskLevel === info!.riskLevel).toBe(true);
    }
    expect(emittedAll.map((e) => e.action)).not.toContain('data_access.read');
    expect(emittedAll.filter((e) => e.action.startsWith('data_access.'))).toEqual([]);
  });

  it('maps every read operation to a specific catalog entry', () => {
    for (const [operation, action] of Object.entries(AUDIT_READ_ACTIONS)) {
      expect(AUDIT_ACTION_INFO[action as keyof typeof AUDIT_ACTION_INFO], operation).toMatchObject({ status: 'specific', category: 'data_access' });
    }
  });

  it('keeps the generic and legacy names out of the source of the readers and the API', () => {
    const roots = ['packages/core/src', 'packages/adapters/src', 'apps/audit-api/src'].map((p) => resolve(__dirname, '../../..', p));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.testing.ts')) files.push(full);
      }
    };
    roots.forEach(walk);
    const banned = /['"`]data_access\.(read|audit_query|audit_trace|audit_aggregate|metrics_summary|metrics_compare)['"`]/;
    expect(files.filter((f) => banned.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
