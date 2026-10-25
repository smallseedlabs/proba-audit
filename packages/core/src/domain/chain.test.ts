import { describe, expect, it } from 'vitest';
import { buildAuditEvent } from '../audit/protocol.js';
import {
  chainEvent,
  computeEventHash,
  contentHash,
  deriveTags,
  nextIngestedAt,
  normalizeForStorage,
  prepareForStorage,
  sameContent,
  STORED_AUDIT_SCHEMA_VERSION,
} from './chain.js';
import type { AuditEvent } from './audit.js';

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent =>
  buildAuditEvent({
    traceId: '11111111-1111-4111-8111-111111111111',
    eventId: '22222222-2222-4222-8222-222222222222',
    spanId: '00000000000000aa',
    workspaceId: 'seedbed',
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
    occurredAt: '2026-10-25T10:00:00.000Z',
    details: { b: 2, a: 1 },
    ...overrides,
  });

describe('deriveTags / prepareForStorage', () => {
  it('derives category, outcome, service and risk tags', () => {
    expect(deriveTags(event())).toEqual(['category:command', 'outcome:success', 'service:hub']);
    expect(deriveTags(event({ riskLevel: 'high' }))).toContain('risk:high');
  });

  it('keeps producer tags first and never duplicates', () => {
    const prepared = prepareForStorage(event({ tags: ['custom', 'category:command'] }));
    expect(prepared.tags).toEqual(['custom', 'category:command', 'outcome:success', 'service:hub']);
    expect(prepareForStorage(prepared)).toEqual(prepared); // idempotent
  });
});

describe('normalizeForStorage', () => {
  it('rounds to storage precision and is idempotent', () => {
    const e = normalizeForStorage(
      event({ occurredAt: '2026-10-25T10:00:00.123456Z', cost: { amount: 0.123456789123, currency: 'USD' } })
    );
    expect(e.occurredAt).toBe('2026-10-25T10:00:00.123Z');
    expect(e.cost?.amount).toBe(0.12345679);
    expect(normalizeForStorage(e)).toEqual(e);
  });
});

describe('content hash', () => {
  it('ignores key order and chain fields, and changes with any content change', () => {
    const a = event({ details: { a: 1, b: 2 } });
    const b = event({ details: { b: 2, a: 1 } });
    expect(contentHash(a)).toBe(contentHash(b));
    const stored = chainEvent(a, null, '2026-10-25T10:00:01.000Z');
    expect(sameContent(prepareForStorage(a), stored)).toBe(true);
    expect(contentHash(event({ outcome: 'failure' }))).not.toBe(contentHash(a));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('chainEvent', () => {
  it('starts a chain with a null prevHash and links the next event to the previous hash', () => {
    const first = chainEvent(event(), null, '2026-10-25T10:00:01.000Z');
    expect(first.prevHash).toBeNull();
    expect(first.schemaVersion).toBe(STORED_AUDIT_SCHEMA_VERSION);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(computeEventHash(first));

    const second = chainEvent(
      event({ eventId: '33333333-3333-4333-8333-333333333333' }),
      { hash: first.hash, ingestedAt: first.ingestedAt },
      '2026-10-25T10:00:01.000Z'
    );
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it('is deterministic', () => {
    const a = chainEvent(event(), null, '2026-10-25T10:00:01.000Z');
    const b = chainEvent(event(), null, '2026-10-25T10:00:01.000Z');
    expect(a).toEqual(b);
  });

  it('covers every stored field: altering anything changes the hash', () => {
    const e = chainEvent(event(), null, '2026-10-25T10:00:01.000Z');
    for (const altered of [
      { ...e, outcome: 'denied' as const },
      { ...e, prevHash: 'a'.repeat(64) },
      { ...e, ingestedAt: '2026-10-25T10:00:02.000Z' },
      { ...e, details: { a: 1, b: 3 } },
      { ...e, tags: [...(e.tags ?? []), 'extra'] },
      { ...e, schemaVersion: 2 },
    ]) {
      expect(computeEventHash(altered)).not.toBe(e.hash);
    }
  });

  it('assigns a strictly increasing ingestedAt even when the clock does not move', () => {
    let head = null as { hash: string; ingestedAt: string } | null;
    const times: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const e = chainEvent(event({ eventId: `00000000-0000-4000-8000-00000000000${i}` }), head, '2026-10-25T10:00:01.000Z');
      head = { hash: e.hash, ingestedAt: e.ingestedAt };
      times.push(e.ingestedAt);
    }
    expect(times).toEqual(['2026-10-25T10:00:01.000Z', '2026-10-25T10:00:01.001Z', '2026-10-25T10:00:01.002Z']);
  });
});

describe('nextIngestedAt', () => {
  it('uses the clock when it is ahead and previous+1ms otherwise', () => {
    expect(nextIngestedAt('2026-10-25T10:00:05.000Z')).toBe('2026-10-25T10:00:05.000Z');
    expect(nextIngestedAt('2026-10-25T10:00:05.000Z', '2026-10-25T10:00:01.000Z')).toBe('2026-10-25T10:00:05.000Z');
    expect(nextIngestedAt('2026-10-25T10:00:01.000Z', '2026-10-25T10:00:05.000Z')).toBe('2026-10-25T10:00:05.001Z');
  });
});
