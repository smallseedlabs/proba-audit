import type {
  AuditAggregateQuery,
  AuditAggregateRow,
  AuditQuery,
  StoredAuditEvent,
} from '../domain/audit.js';
import type { AuditActor } from './protocol.js';
import type { AuditEmitter } from '../ports/audit-emitter.js';
import type { AuditStore } from '../ports/audit-store.js';
import type { Clock } from '../ports/clock.js';

/** Who is reading, and under which trace (the API request). */
export interface AccessContext {
  actor: AuditActor;
  workspaceId: string;
  userId?: string;
  traceId?: string;
  parentSpanId?: string;
}

/**
 * Self-audit for reads: every query against the audit store is itself recorded
 * as a `data_access.audit_*` event through the AuditEmitter (so it travels over
 * the same bus and is chained like any other event). audit-api routes call these
 * methods instead of the store directly. The event records which filters were used
 * (names only, not values) and the result size, never the returned data.
 */
export class AuditedReader {
  constructor(
    private readonly store: AuditStore,
    private readonly emitter: AuditEmitter,
    private readonly clock: Clock
  ) {}

  query(ctx: AccessContext, query: AuditQuery): Promise<StoredAuditEvent[]> {
    return this.audited(ctx, 'data_access.audit_query', query, (rows) => rows.length, () => this.store.query(query));
  }

  getTrace(
    ctx: AccessContext,
    traceId: string,
    options?: { workspaceId?: string; limit?: number }
  ): Promise<StoredAuditEvent[]> {
    return this.audited(
      ctx,
      'data_access.audit_trace',
      { traceId, ...options },
      (rows) => rows.length,
      () => this.store.getTrace(traceId, options)
    );
  }

  aggregate(ctx: AccessContext, query: AuditAggregateQuery): Promise<AuditAggregateRow[]> {
    return this.audited(
      ctx,
      'data_access.audit_aggregate',
      { ...query.filter, groupBy: query.groupBy },
      (rows) => rows.length,
      () => this.store.aggregate(query)
    );
  }

  private async audited<T>(
    ctx: AccessContext,
    action: string,
    filters: object,
    size: (result: T) => number,
    run: () => Promise<T>
  ): Promise<T> {
    const started = this.clock.now().getTime();
    const emitter = ctx.traceId ? this.emitter.forTrace(ctx.traceId, ctx.parentSpanId) : this.emitter;
    const emit = async (outcome: 'success' | 'failure', extra: Record<string, unknown>, error?: Error): Promise<void> => {
      await emitter.emit({
        actor: ctx.actor,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        action,
        category: 'data_access',
        outcome,
        target: { type: 'audit_events', id: ctx.workspaceId },
        durationMs: this.clock.now().getTime() - started,
        errorMessage: error?.message.slice(0, 500),
        details: {
          filters: Object.entries(filters)
            .filter(([, v]) => v !== undefined)
            .map(([k]) => k)
            .sort(),
          ...extra,
        },
      });
    };

    let result: T;
    try {
      result = await run();
    } catch (err) {
      await emit('failure', {}, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    await emit('success', { resultCount: size(result) });
    return result;
  }
}
