import {
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  bucketStart,
  type AppendResult,
  type AuditAggregateQuery,
  type AuditAggregateRow,
  type AuditEventRef,
  type AuditFilter,
  type AuditGroupBy,
  type AuditQuery,
  type AuditStore,
  type ChainHead,
  type ReadChainOptions,
  type StoredAuditEvent,
  CHAIN_READ_DEFAULT_LIMIT,
  CHAIN_READ_MAX_LIMIT,
  sameContent,
} from '@smallseedlabs/proba-audit-core';

export function matchesAuditFilter(e: StoredAuditEvent, f: AuditFilter): boolean {
  return (
    (f.workspaceId === undefined || e.workspaceId === f.workspaceId) &&
    (f.traceId === undefined || e.traceId === f.traceId) &&
    (f.userId === undefined || e.userId === f.userId) &&
    (f.goalId === undefined || e.goalId === f.goalId) &&
    (f.threadId === undefined || e.threadId === f.threadId) &&
    (f.campaignId === undefined || e.campaignId === f.campaignId) &&
    (f.actorType === undefined || e.actor.type === f.actorType) &&
    (f.actorId === undefined || e.actor.id === f.actorId) &&
    (f.service === undefined || e.service === f.service) &&
    (f.category === undefined || e.category === f.category) &&
    (f.action === undefined || e.action === f.action) &&
    (f.outcome === undefined || e.outcome === f.outcome) &&
    (f.riskLevel === undefined || e.riskLevel === f.riskLevel) &&
    (f.from === undefined || Date.parse(e.occurredAt) >= Date.parse(f.from)) &&
    (f.to === undefined || Date.parse(e.occurredAt) < Date.parse(f.to))
  );
}

function groupValue(e: StoredAuditEvent, key: AuditGroupBy): string {
  switch (key) {
    case 'category':
      return e.category;
    case 'action':
      return e.action;
    case 'outcome':
      return e.outcome;
    case 'service':
      return e.service;
    case 'actorType':
      return e.actor.type;
    case 'riskLevel':
      return e.riskLevel ?? '';
    case 'currency':
      return e.cost?.currency ?? '';
    case 'hour':
      return bucketStart(e.occurredAt, 'hour');
    case 'day':
      return bucketStart(e.occurredAt, 'day');
  }
}

/** In-process AuditStore following the port's semantics. For tests and local runs. */
export class InMemoryAuditStore implements AuditStore {
  private readonly events = new Map<string, StoredAuditEvent>();

  async appendBatch(events: StoredAuditEvent[]): Promise<AppendResult> {
    let inserted = 0;
    let duplicates = 0;
    const conflicts: string[] = [];
    for (const e of events) {
      const existing = this.events.get(e.eventId);
      if (!existing) {
        this.events.set(e.eventId, structuredClone(e));
        inserted += 1;
      } else if (sameContent(existing, e)) {
        duplicates += 1;
      } else if (!conflicts.includes(e.eventId)) {
        conflicts.push(e.eventId);
      }
    }
    return { inserted, duplicates, conflicts };
  }

  async findExisting(refs: AuditEventRef[]): Promise<StoredAuditEvent[]> {
    return refs.flatMap((r) => {
      const e = this.events.get(r.eventId);
      return e && e.workspaceId === r.workspaceId ? [structuredClone(e)] : [];
    });
  }

  async readChain(workspaceId: string, options: ReadChainOptions = {}): Promise<StoredAuditEvent[]> {
    const limit = Math.min(options.limit ?? CHAIN_READ_DEFAULT_LIMIT, CHAIN_READ_MAX_LIMIT);
    const dir = (options.order ?? 'asc') === 'asc' ? 1 : -1;
    const cmp = (a: { ingestedAt: string; eventId: string }, b: { ingestedAt: string; eventId: string }): number =>
      Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt) || a.eventId.localeCompare(b.eventId);
    return [...this.events.values()]
      .filter(
        (e) =>
          e.workspaceId === workspaceId &&
          (options.from === undefined || Date.parse(e.ingestedAt) >= Date.parse(options.from)) &&
          (options.to === undefined || Date.parse(e.ingestedAt) < Date.parse(options.to)) &&
          (options.after === undefined || dir * cmp(e, options.after) > 0)
      )
      .sort((a, b) => dir * cmp(a, b))
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  async query(query: AuditQuery): Promise<StoredAuditEvent[]> {
    const limit = Math.min(query.limit ?? AUDIT_QUERY_DEFAULT_LIMIT, AUDIT_QUERY_MAX_LIMIT);
    const dir = (query.order ?? 'desc') === 'asc' ? 1 : -1;
    return [...this.events.values()]
      .filter((e) => matchesAuditFilter(e, query))
      .sort((a, b) => dir * (a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)))
      .slice(query.offset ?? 0, (query.offset ?? 0) + limit)
      .map((e) => structuredClone(e));
  }

  async getTrace(
    traceId: string,
    options: { workspaceId?: string; limit?: number } = {}
  ): Promise<StoredAuditEvent[]> {
    return this.query({ traceId, workspaceId: options.workspaceId, order: 'asc', limit: options.limit });
  }

  async aggregate(query: AuditAggregateQuery): Promise<AuditAggregateRow[]> {
    const rows = new Map<string, AuditAggregateRow>();
    for (const e of this.events.values()) {
      if (!matchesAuditFilter(e, query.filter)) continue;
      const values = query.groupBy.map((k) => groupValue(e, k));
      const id = JSON.stringify(values);
      let row = rows.get(id);
      if (!row) {
        row = {
          keys: Object.fromEntries(query.groupBy.map((k, i) => [k, values[i]])),
          count: 0,
          durationMsSum: 0,
          tokensInSum: 0,
          tokensOutSum: 0,
          costAmountSum: 0,
        };
        rows.set(id, row);
      }
      row.count += 1;
      row.durationMsSum += e.durationMs ?? 0;
      row.tokensInSum += e.cost?.tokensIn ?? 0;
      row.tokensOutSum += e.cost?.tokensOut ?? 0;
      row.costAmountSum += e.cost?.amount ?? 0;
    }
    return [...rows.entries()]
      .sort(([a], [b]) => (JSON.parse(a) as string[]).join('\u0000').localeCompare((JSON.parse(b) as string[]).join('\u0000')))
      .map(([, row]) => ({ ...row, costAmountSum: Math.round(row.costAmountSum * 1e8) / 1e8 }));
  }

  async getChainHead(workspaceId: string): Promise<ChainHead | null> {
    let head: StoredAuditEvent | null = null;
    for (const e of this.events.values()) {
      if (e.workspaceId !== workspaceId) continue;
      if (!head || e.ingestedAt.localeCompare(head.ingestedAt) > 0 || (e.ingestedAt === head.ingestedAt && e.eventId.localeCompare(head.eventId) > 0)) {
        head = e;
      }
    }
    return head ? { eventId: head.eventId, hash: head.hash, ingestedAt: head.ingestedAt } : null;
  }

  async ping(): Promise<void> {
    // Always reachable.
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
