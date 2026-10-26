import type { AccessContext } from '../audit/audited-reader.js';
import type { AuditEmitter } from '../ports/audit-emitter.js';
import type { Clock } from '../ports/clock.js';
import {
  AnalyticsValidationError,
  type AnalyticsScope,
  type CompareQuery,
  type MetricsAnalytics,
  type MetricsSummary,
  type PeriodComparison,
  type SummaryQuery,
} from './metrics-analytics.js';

/**
 * Resolves what the caller may see. Implemented by trusted code from the authenticated
 * session (workspace membership -> connected ad accounts). Callers of the reader never
 * pass a scope, so a request cannot ask for another workspace's accounts.
 */
export type ScopeResolver = (ctx: AccessContext) => Promise<AnalyticsScope>;

/**
 * AuditedReader's counterpart for metrics: every analytics read is recorded as a
 * `data_access.metrics_*` event through the AuditEmitter, under the caller's trace.
 * The event names the filters used (names only) and the size of the result, never the numbers.
 * Failures (including rejected queries) are recorded too, then rethrown.
 */
export class AuditedAnalyticsReader {
  constructor(
    private readonly analytics: MetricsAnalytics,
    private readonly resolveScope: ScopeResolver,
    private readonly emitter: AuditEmitter,
    private readonly clock: Clock
  ) {}

  getMetricsSummary(ctx: AccessContext, query: SummaryQuery): Promise<MetricsSummary> {
    return this.audited(
      ctx,
      'data_access.metrics_summary',
      { campaignId: query.campaignId, from: query.from, to: query.to, granularity: query.granularity },
      (r) => r.series.length + (r.campaigns?.length ?? 0),
      (scope) => this.analytics.getMetricsSummary(scope, query)
    );
  }

  comparePeriods(ctx: AccessContext, query: CompareQuery): Promise<PeriodComparison> {
    return this.audited(
      ctx,
      'data_access.metrics_compare',
      { campaignId: query.campaignId, current: query.current, previous: query.previous, granularity: query.granularity },
      (r) => r.comparison.length,
      (scope) => this.analytics.comparePeriods(scope, query)
    );
  }

  private async audited<T>(
    ctx: AccessContext,
    action: string,
    filters: Record<string, unknown>,
    size: (result: T) => number,
    run: (scope: AnalyticsScope) => Promise<T>
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
        target: { type: 'metrics', id: ctx.workspaceId },
        ...(error instanceof AnalyticsValidationError ? { errorCode: 'invalid_query' } : {}),
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
      const scope = await this.resolveScope(ctx);
      if (scope.workspaceId !== ctx.workspaceId) {
        throw new Error('scope does not belong to the caller workspace');
      }
      result = await run(scope);
    } catch (err) {
      await emit('failure', {}, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    await emit('success', { resultCount: size(result) });
    return result;
  }
}
