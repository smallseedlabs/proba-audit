import { describe, expect, it } from 'vitest';
import { makeStoredAuditEvent } from '../testing/fixtures.js';
import { buildTraceTree } from './span-tree.js';
import { highestRisk, pickRootEvent, summarizeTrace, worstOutcome } from '../domain/audit-read.js';

const span = (n: number) => `b${n.toString(16).padStart(15, '0')}`;
const ev = (n: number, extra: object = {}) =>
  makeStoredAuditEvent({ spanId: span(n), eventId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, occurredAt: `2026-10-25T10:00:${String(n).padStart(2, '0')}.000Z`, ...extra });

describe('worstOutcome and highestRisk', () => {
  it('rank failure > denied > partial > success and high > medium > low', () => {
    expect(worstOutcome([])).toBe('success');
    expect(worstOutcome(['success', 'partial'])).toBe('partial');
    expect(worstOutcome(['partial', 'denied', 'success'])).toBe('denied');
    expect(worstOutcome(['denied', 'failure'])).toBe('failure');
    expect(highestRisk([undefined, undefined])).toBeUndefined();
    expect(highestRisk(['low', undefined, 'high', 'medium'])).toBe('high');
  });
});

describe('pickRootEvent and summarizeTrace', () => {
  it('prefers the earliest event without a parent, then the earliest event', () => {
    const child = ev(1, { parentSpanId: span(9) });
    const root = ev(2);
    expect(pickRootEvent([child, root])).toBe(root);
    expect(pickRootEvent([ev(3, { parentSpanId: span(9) }), child])).toBe(child);
    expect(pickRootEvent([])).toBeUndefined();
    expect(summarizeTrace([])).toBeUndefined();
  });

  it('summarises outcome, risk and the extent of the trace including durations', () => {
    const s = summarizeTrace([ev(0, { durationMs: 10 }), ev(1, { parentSpanId: span(0), outcome: 'failure', riskLevel: 'high', durationMs: 4000 })]);
    expect(s).toMatchObject({ eventCount: 2, outcome: 'failure', riskLevel: 'high', startedAt: '2026-10-25T10:00:00.000Z', lastEventAt: '2026-10-25T10:00:01.000Z', durationMs: 5000 });
  });
});

describe('buildTraceTree', () => {
  it('nests children under their parent by span id and orders siblings by time', () => {
    const tree = buildTraceTree('t', [ev(3, { parentSpanId: span(1) }), ev(1), ev(2, { parentSpanId: span(1) }), ev(4, { parentSpanId: span(2) })]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].children.map((c) => c.spanId)).toEqual([span(2), span(3)]);
    expect(tree.roots[0].children[0].children.map((c) => c.spanId)).toEqual([span(4)]);
    expect(tree.eventCount).toBe(4);
    expect(tree.roots[0].children[0].offsetMs).toBe(1000);
  });

  it('rolls the worst outcome up to every ancestor but not to siblings', () => {
    const tree = buildTraceTree('t', [ev(1), ev(2, { parentSpanId: span(1) }), ev(3, { parentSpanId: span(1), outcome: 'denied' }), ev(4, { parentSpanId: span(2), outcome: 'failure' })]);
    const [root] = tree.roots;
    expect(root.subtreeOutcome).toBe('failure');
    expect(root.children[0].subtreeOutcome).toBe('failure');
    expect(root.children[1].subtreeOutcome).toBe('denied');
    expect(tree.outcome).toBe('failure');
  });

  it('marks orphans as roots, keeps events that share a span, and flags truncation', () => {
    const tree = buildTraceTree('t', [ev(1), ev(2, { parentSpanId: span(8) }), ev(3, { spanId: span(1) })], { truncated: true });
    expect(tree.roots.map((r) => [r.spanId, r.orphan ?? false])).toEqual([[span(1), false], [span(2), true], [span(1), false]]);
    expect(tree.eventCount).toBe(3);
    expect(tree.truncated).toBe(true);
  });

  it('breaks loops and self-parents without recursing forever', () => {
    const tree = buildTraceTree('t', [ev(1, { parentSpanId: span(2) }), ev(2, { parentSpanId: span(1) }), ev(3, { parentSpanId: span(3) })]);
    const count = (nodes: typeof tree.roots): number => nodes.reduce((n, x) => n + 1 + count(x.children), 0);
    expect(count(tree.roots)).toBe(3);
    expect(() => JSON.stringify(tree)).not.toThrow();
  });

  it('handles an empty trace', () => {
    expect(buildTraceTree('t', [])).toMatchObject({ eventCount: 0, roots: [], durationMs: 0, outcome: 'success' });
  });

  it('collects related goal, thread and campaign ids once each', () => {
    const tree = buildTraceTree('t', [ev(1, { goalId: 'a', campaignId: 'c' }), ev(2, { goalId: 'a', threadId: 't1' })]);
    expect(tree.related).toEqual({ goalIds: ['a'], threadIds: ['t1'], campaignIds: ['c'] });
  });
});
