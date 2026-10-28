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

/**
 * Which catalogued audit action records each kind of read of the audit trail (protocol 0.3.2+, category
 * `data_access`, risk low). The protocol's generic read action is not used (a test scans for it).
 */
export const AUDIT_READ_ACTIONS = {
  'events.search': 'audit.searched',
  'traces.list': 'audit.searched',
  'facets.list': 'audit.searched',
  'events.get': 'audit.event_viewed',
  'traces.get': 'audit.trace_viewed',
  'chain.verify': 'audit.integrity_checked',
} as const;

export type AuditReadOperation = keyof typeof AUDIT_READ_ACTIONS;

/** Who is reading, and under which trace (the API request). */
export interface AccessContext {
  actor: AuditActor;
  workspaceId: string;
  userId?: string;
  traceId?: string;
  parentSpanId?: string;
  /**
   * Set when the reader acts for one user (the `context-reader` role): analytics are limited to the campaigns of the
   * goals this user owns. The id is the user's, not the caller's (the caller is `actor`).
   */
  subjectActorId?: string;
  /** Added to the `details` of the audit event of every read (who called, which assertion). Never data. */
  auditDetails?: Record<string, unknown>;
}

/**
 * Self-audit for reads: every query against the audit store is itself recorded
 * as an `audit.*` event (`audit.searched`, `audit.trace_viewed`) through the AuditEmitter (so it travels over
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

  /** Like every typed read, scoped to the caller's workspace (`ctx.workspaceId`), whatever the query says. */
  query(ctx: AccessContext, query: AuditQuery): Promise<StoredAuditEvent[]> {
    const scoped = { ...query, workspaceId: ctx.workspaceId };
    return this.audited(ctx, 'audit.searched', scoped, (rows) => rows.length, () => this.store.query(scoped), { operation: 'query' });
  }

  /** The workspace is always the caller's (`ctx.workspaceId`); there is no way to ask for another one. */
  getTrace(ctx: AccessContext, traceId: string, options?: { limit?: number }): Promise<StoredAuditEvent[]> {
    return this.audited(
      ctx,
      'audit.trace_viewed',
      { traceId, ...options },
      (rows) => rows.length,
      () => this.store.getTrace(ctx.workspaceId, traceId, options),
      { operation: 'trace' },
      { type: 'trace', id: traceId }
    );
  }

  aggregate(ctx: AccessContext, query: AuditAggregateQuery): Promise<AuditAggregateRow[]> {
    const scoped = { ...query, filter: { ...query.filter, workspaceId: ctx.workspaceId } };
    return this.audited(
      ctx,
      'audit.searched',
      { ...scoped.filter, groupBy: query.groupBy },
      (rows) => rows.length,
      () => this.store.aggregate(scoped),
      { operation: 'aggregate' }
    );
  }

  /**
   * A read of any other shape (the HTTP read API: event search, one event, trace list, facets,
   * chain verification) recorded with the specific action for that operation (`AUDIT_READ_ACTIONS`:
   * `audit.searched`, `audit.event_viewed`, `audit.trace_viewed`, `audit.integrity_checked`).
   * `operation` is also kept in the details, and `details` adds non-sensitive context such as the
   * route; neither may carry returned data, credentials or personal data. Reads of one event or
   * trace name it as the target, as the catalog describes.
   */
  read<T>(
    ctx: AccessContext,
    operation: AuditReadOperation,
    filters: object,
    size: (result: T) => number,
    run: () => Promise<T>,
    details: Record<string, unknown> = {}
  ): Promise<T> {
    const f = filters as { eventId?: string; traceId?: string };
    const target =
      operation === 'events.get' && f.eventId ? { type: 'audit_event', id: f.eventId } : operation === 'traces.get' && f.traceId ? { type: 'trace', id: f.traceId } : undefined;
    return this.audited(ctx, AUDIT_READ_ACTIONS[operation], filters, size, run, { operation, ...details }, target);
  }

  /**
   * A read that returns raw text (AuditEvent.content), recorded with the specific action for what was
   * read (`audit.event_viewed` for one event, `audit.trace_viewed` for a trace) and `contentIncluded: true`,
   * so who read which text is always answerable. `target` is the record read. Never carries the text itself.
   * If the audit event cannot be sent the read fails (the emitter is the API's fail-closed one).
   */
  readContent<T>(
    ctx: AccessContext,
    action: 'audit.event_viewed' | 'audit.trace_viewed',
    operation: string,
    filters: object,
    size: (result: T) => number,
    run: () => Promise<T>,
    target: { type: string; id: string },
    details: Record<string, unknown> = {}
  ): Promise<T> {
    return this.audited(ctx, action, filters, size, run, { operation, ...details, contentIncluded: true }, target);
  }

  private async audited<T>(
    ctx: AccessContext,
    action: string,
    filters: object,
    size: (result: T) => number,
    run: () => Promise<T>,
    context: Record<string, unknown> = {},
    target: { type: string; id: string } = { type: 'audit_events', id: ctx.workspaceId }
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
        target,
        durationMs: this.clock.now().getTime() - started,
        errorMessage: error?.message.slice(0, 500),
        details: {
          ...ctx.auditDetails,
          ...context,
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
