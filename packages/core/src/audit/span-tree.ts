import type { AuditActorType, AuditCategory, AuditOutcome, AuditRiskLevel, StoredAuditEvent } from '../domain/audit.js';
import { highestRisk, worstOutcome } from '../domain/audit-read.js';

/** One event of a trace, placed in the parent/child tree by its span ids. */
export interface SpanNode {
  eventId: string;
  spanId: string;
  parentSpanId?: string;
  action: string;
  service: string;
  category: AuditCategory;
  outcome: AuditOutcome;
  riskLevel?: AuditRiskLevel;
  actor: { type: AuditActorType; id: string };
  target?: { type: string; id: string };
  errorCode?: string;
  goalId?: string;
  threadId?: string;
  campaignId?: string;
  /** occurredAt, treated as the moment the step started. */
  startedAt: string;
  /** Milliseconds from the start of the trace to this step. */
  offsetMs: number;
  /** The step's own duration, when the producer reported one. */
  durationMs: number | null;
  /** Worst outcome in this step and everything below it. */
  subtreeOutcome: AuditOutcome;
  /** True when parentSpanId names a span that is not in the trace (or the links form a loop). */
  orphan?: boolean;
  children: SpanNode[];
}

export interface TraceTree {
  traceId: string;
  startedAt: string;
  /** Latest end of any step (occurredAt + durationMs). */
  endedAt: string;
  durationMs: number;
  eventCount: number;
  /** Worst outcome of the whole trace. */
  outcome: AuditOutcome;
  riskLevel?: AuditRiskLevel;
  /** True when the trace has more events than were loaded. */
  truncated: boolean;
  roots: SpanNode[];
  /** Records the trace belongs to, for links in a UI. */
  related: { goalIds: string[]; threadIds: string[]; campaignIds: string[] };
}

const byTimeThenId = (a: StoredAuditEvent, b: StoredAuditEvent): number =>
  Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.eventId.localeCompare(b.eventId);

/**
 * Build the span tree of one trace. Tolerant of what real data looks like: a parent that
 * was never stored makes its child an orphan root, two events sharing a span id both appear,
 * and a loop in the parent links is broken instead of recursing forever.
 */
export function buildTraceTree(traceId: string, events: readonly StoredAuditEvent[], options: { truncated?: boolean } = {}): TraceTree {
  const sorted = [...events].sort(byTimeThenId);
  const start = sorted.length > 0 ? Date.parse(sorted[0].occurredAt) : 0;

  const nodes = sorted.map((e): SpanNode => ({
    eventId: e.eventId,
    spanId: e.spanId,
    ...(e.parentSpanId !== undefined ? { parentSpanId: e.parentSpanId } : {}),
    action: e.action,
    service: e.service,
    category: e.category,
    outcome: e.outcome,
    ...(e.riskLevel !== undefined ? { riskLevel: e.riskLevel } : {}),
    actor: { type: e.actor.type, id: e.actor.id },
    ...(e.target ? { target: { type: e.target.type, id: e.target.id } } : {}),
    ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}),
    ...(e.goalId !== undefined ? { goalId: e.goalId } : {}),
    ...(e.threadId !== undefined ? { threadId: e.threadId } : {}),
    ...(e.campaignId !== undefined ? { campaignId: e.campaignId } : {}),
    startedAt: e.occurredAt,
    offsetMs: Date.parse(e.occurredAt) - start,
    durationMs: e.durationMs ?? null,
    subtreeOutcome: e.outcome,
    children: [],
  }));

  const bySpan = new Map<string, SpanNode>();
  for (const n of nodes) if (!bySpan.has(n.spanId)) bySpan.set(n.spanId, n);

  const roots: SpanNode[] = [];
  for (const n of nodes) {
    const parent = n.parentSpanId === undefined ? undefined : bySpan.get(n.parentSpanId);
    if (parent && parent !== n) parent.children.push(n);
    else {
      if (n.parentSpanId !== undefined) n.orphan = true;
      roots.push(n);
    }
  }

  // Anything not reachable from a root sits in a loop of parent links: surface it as an orphan root.
  const seen = new Set<SpanNode>();
  const visit = (n: SpanNode): void => {
    if (seen.has(n)) return;
    seen.add(n);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const parent = n.parentSpanId === undefined ? undefined : bySpan.get(n.parentSpanId);
    if (parent) parent.children = parent.children.filter((c) => c !== n);
    n.orphan = true;
    roots.push(n);
    visit(n);
  }

  const rollUp = (n: SpanNode): AuditOutcome => {
    n.subtreeOutcome = worstOutcome([n.outcome, ...n.children.map(rollUp)]);
    return n.subtreeOutcome;
  };
  roots.forEach(rollUp);

  let end = start;
  for (const e of sorted) end = Math.max(end, Date.parse(e.occurredAt) + (e.durationMs ?? 0));
  const riskLevel = highestRisk(sorted.map((e) => e.riskLevel));
  const uniq = (values: (string | undefined)[]): string[] => [...new Set(values.filter((v): v is string => v !== undefined))].sort();

  return {
    traceId,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    durationMs: Math.round(end - start),
    eventCount: sorted.length,
    outcome: worstOutcome(sorted.map((e) => e.outcome)),
    ...(riskLevel ? { riskLevel } : {}),
    truncated: options.truncated ?? false,
    roots,
    related: {
      goalIds: uniq(sorted.map((e) => e.goalId)),
      threadIds: uniq(sorted.map((e) => e.threadId)),
      campaignIds: uniq(sorted.map((e) => e.campaignId)),
    },
  };
}
