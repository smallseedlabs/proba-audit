/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are inspected loosely in tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuditContent, type StoredAuditEvent } from '@smallseedlabs/proba-audit-core';
import { TOKENS, WORKSPACE, createHarness, makeEvent, seedWithContent, chainAll, type Harness } from './harness.testing.js';

const USER_TEXT = 'Please pause the Black Friday campaign and email me the spend.';
const REPLY_TEXT = 'Paused. Spend so far is 412.50 EUR.';
const SECRET_FREE_EMAIL = 'ask maria@example.com';

let h: Harness;
let seeded: StoredAuditEvent[];
let traceId: string;

async function open(env: Record<string, string> = { AUDIT_CONTENT_ENABLED: 'true' }): Promise<void> {
  h = await createHarness({ env });
  traceId = '20000000-0000-4000-8000-000000000001';
  seeded = await seedWithContent(h, [
    { event: { traceId, action: 'thread.message_received', category: 'command', occurredAt: '2026-10-25T10:00:00.000Z' }, content: buildAuditContent('user_message', USER_TEXT) },
    { event: { traceId, action: 'brain.reply_generated', category: 'brain', occurredAt: '2026-10-25T10:00:02.000Z' }, content: buildAuditContent('brain_reply', REPLY_TEXT, { redactions: 1 }) },
    { event: { traceId, action: 'command.received', occurredAt: '2026-10-25T10:00:03.000Z' }, content: { kind: 'user_message', text: SECRET_FREE_EMAIL, truncated: false, originalLength: SECRET_FREE_EMAIL.length, redactions: 0 } },
    { event: { traceId, action: 'command.completed', occurredAt: '2026-10-25T10:00:04.000Z' } as any, content: undefined as any },
  ]);
}

beforeEach(async () => {
  await open();
});
afterEach(async () => {
  await h.close();
});

describe('raw text: role gating', () => {
  it('serves an event text to an administrator, with its digest and verified=true', async () => {
    const res = await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      eventId: seeded[0].eventId,
      action: 'thread.message_received',
      content: { kind: 'user_message', text: USER_TEXT, truncated: false, originalLength: USER_TEXT.length, redactions: 0 },
      contentDigest: seeded[0].contentDigest,
      verified: true,
    });
  });

  it('refuses a viewer, audits the refusal, and reads nothing', async () => {
    const res = await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.viewer);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_role');
    expect(JSON.stringify(res.body)).not.toContain(USER_TEXT);
    const emitted = await h.emitted();
    expect(emitted.map((e) => [e.action, e.outcome])).toEqual([['auth.denied', 'denied']]);
  });

  it('refuses a viewer on the trace route too, and an anonymous caller', async () => {
    expect((await h.get(`/v1/traces/${traceId}/content`, TOKENS.viewer)).status).toBe(403);
    expect((await h.get(`/v1/traces/${traceId}/content`, null)).status).toBe(401);
    expect((await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.outsider)).status).toBe(403);
  });

  it('never puts text in the ordinary event routes; viewers do not even see the digest', async () => {
    for (const token of [TOKENS.viewer, TOKENS.admin]) {
      const list = await h.get('/v1/events?limit=50', token);
      const one = await h.get(`/v1/events/${seeded[0].eventId}`, token);
      const trace = await h.get(`/v1/traces/${traceId}`, token);
      for (const res of [list, one, trace]) {
        expect(res.status).toBe(200);
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(USER_TEXT);
        expect(raw).not.toContain(REPLY_TEXT);
        expect(raw).not.toContain('"content"');
      }
      const withText = list.body.events.find((e: any) => e.eventId === seeded[0].eventId);
      const without = list.body.events.find((e: any) => e.eventId === seeded[3].eventId);
      expect(withText.hasContent).toBe(true);
      expect(without.hasContent).toBeUndefined();
      expect('contentDigest' in withText).toBe(token === TOKENS.admin);
      expect('contentDigest' in one.body).toBe(token === TOKENS.admin);
    }
  });

  it('returns the texts of a trace to an administrator, oldest first, leaving out events without text', async () => {
    const res = await h.get(`/v1/traces/${traceId}/content`, TOKENS.admin);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => [i.action, i.content.text, i.verified])).toEqual([
      ['thread.message_received', USER_TEXT, true],
      ['brain.reply_generated', REPLY_TEXT, true],
      ['command.received', SECRET_FREE_EMAIL, true],
    ]);
    expect(res.body.truncated).toBe(false);
  });

  it('answers 404 for an event without text, an unknown event and an unknown trace', async () => {
    expect((await h.get(`/v1/events/${seeded[3].eventId}/content`, TOKENS.admin)).status).toBe(404);
    expect((await h.get('/v1/events/99999999-9999-4999-8999-999999999999/content', TOKENS.admin)).status).toBe(404);
    expect((await h.get('/v1/traces/99999999-9999-4999-8999-999999999999/content', TOKENS.admin)).status).toBe(404);
  });

  it('keeps workspaces apart', async () => {
    const [foreign] = chainAll([makeEvent({ workspaceId: 'other-workspace', content: buildAuditContent('user_message', 'foreign text') })]);
    await h.store.appendBatch([foreign]);
    await h.contentStore.put([{ workspaceId: 'other-workspace', eventId: foreign.eventId, occurredAt: foreign.occurredAt, content: buildAuditContent('user_message', 'foreign text'), contentDigest: foreign.contentDigest! }]);
    expect((await h.get(`/v1/events/${foreign.eventId}/content`, TOKENS.admin)).status).toBe(404);
  });
});

describe('raw text: every content read is audited', () => {
  it('records audit.event_viewed with contentIncluded=true, naming the event but never the text', async () => {
    await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.admin);
    const emitted = await h.emitted();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      action: 'audit.event_viewed',
      category: 'data_access',
      outcome: 'success',
      workspaceId: WORKSPACE,
      actor: { type: 'user', id: 'uid-admin' },
      target: { type: 'audit_event', id: seeded[0].eventId },
      details: { operation: 'events.content', contentIncluded: true, resultCount: 1, role: 'admin' },
    });
    const raw = JSON.stringify(emitted);
    for (const text of [USER_TEXT, REPLY_TEXT, SECRET_FREE_EMAIL]) expect(raw).not.toContain(text);
  });

  it('records audit.trace_viewed with contentIncluded=true and the number of texts returned', async () => {
    await h.get(`/v1/traces/${traceId}/content`, TOKENS.admin);
    const [e] = await h.emitted();
    expect(e).toMatchObject({
      action: 'audit.trace_viewed',
      target: { type: 'trace', id: traceId },
      details: { operation: 'traces.content', contentIncluded: true, resultCount: 3 },
    });
  });

  it('does not return the text when the read cannot be audited (fails closed)', async () => {
    await h.close();
    h = await createHarness({
      env: { AUDIT_CONTENT_ENABLED: 'true' },
      emitter: () => ({ emit: async () => Promise.reject(new Error('bus down')), emitBatch: async () => Promise.reject(new Error('bus down')) }) as any,
    });
    seeded = await seedWithContent(h, [{ content: buildAuditContent('user_message', USER_TEXT) }]);
    const res = await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.admin);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toContain(USER_TEXT);
  });
});

describe('raw text: integrity', () => {
  it('reports verified=false when the stored text was altered after it was chained', async () => {
    h.contentStore.tamper(WORKSPACE, seeded[0].eventId, 'Please DELETE the Black Friday campaign');
    const one = await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.admin);
    expect(one.status).toBe(200);
    expect(one.body.verified).toBe(false);
    const trace = await h.get(`/v1/traces/${traceId}/content`, TOKENS.admin);
    expect(trace.body.items.map((i: any) => i.verified)).toEqual([false, true, true]);
  });

  it('chain verification flags altered text as content_mismatch and counts text removed by retention as missing', async () => {
    h.contentStore.tamper(WORKSPACE, seeded[1].eventId, 'something else');
    h.contentStore.delete(WORKSPACE, seeded[2].eventId);
    const res = await h.get('/v1/chain/verify?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z', TOKENS.admin);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.problems.map((p: any) => [p.type, p.eventId])).toEqual([['content_mismatch', seeded[1].eventId]]);
    expect(res.body.content).toEqual({ checked: 2, missing: 1 });
  });

  it('chain verification is ok with intact and with retention-removed text', async () => {
    h.contentStore.delete(WORKSPACE, seeded[0].eventId);
    const res = await h.get('/v1/chain/verify?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z', TOKENS.admin);
    expect(res.body).toMatchObject({ ok: true, content: { checked: 2, missing: 1 } });
  });
});

describe('raw text: AUDIT_CONTENT_ENABLED=false', () => {
  beforeEach(async () => {
    await h.close();
    await open({});
  });

  it('answers 404 content_disabled even to an administrator, and the events do not claim text exists', async () => {
    const one = await h.get(`/v1/events/${seeded[0].eventId}/content`, TOKENS.admin);
    expect(one.status).toBe(404);
    expect(JSON.stringify(one.body)).toContain('content_disabled');
    expect((await h.get(`/v1/traces/${traceId}/content`, TOKENS.admin)).status).toBe(404);
    const list = await h.get('/v1/events?limit=50', TOKENS.admin);
    expect(JSON.stringify(list.body)).not.toContain('hasContent');
    expect(JSON.stringify(list.body)).not.toContain('contentDigest');
    // Nothing was read, so nothing is recorded as a text read.
    expect((await h.emitted()).filter((e) => e.details.contentIncluded)).toEqual([]);
  });

  it('still verifies the chain without comparing text', async () => {
    const res = await h.get('/v1/chain/verify?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z', TOKENS.admin);
    expect(res.body.ok).toBe(true);
    expect(res.body.content).toBeUndefined();
  });
});
