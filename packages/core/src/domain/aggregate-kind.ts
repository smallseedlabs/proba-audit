/**
 * Whether a MetricObservation is a period total that may be summed, or a running
 * snapshot that must not be added to other periods (or to a later copy of itself).
 *
 * Protocol MetricObservation has no aggregate-kind field. Ads Reddit reports in
 * this slice emit one row per DATE/DATETIME whose [periodStart, periodEnd) matches
 * the requested hour or day, so they are period deltas. A row whose window is
 * longer than two grains is treated as a cumulative snapshot: stored, never summed.
 */

import type { MetricGranularity } from './metrics.js';

export type AggregateKind = 'period_delta' | 'cumulative_snapshot';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface PeriodBounds {
  granularity: MetricGranularity;
  periodStart: string;
  periodEnd: string;
}

/**
 * Hour rows may span up to two hours (clock skew). Day rows may span up to two
 * UTC days so a 23- or 25-hour DST local day still counts as one period total.
 * Anything longer is a snapshot or a multi-day range total: do not add it.
 */
export function inferAggregateKind(period: PeriodBounds): AggregateKind {
  const ms = Date.parse(period.periodEnd) - Date.parse(period.periodStart);
  if (!Number.isFinite(ms) || ms <= 0) return 'cumulative_snapshot';
  if (period.granularity === 'hour') return ms <= 2 * HOUR_MS ? 'period_delta' : 'cumulative_snapshot';
  return ms <= 2 * DAY_MS ? 'period_delta' : 'cumulative_snapshot';
}

export function isPeriodDelta(period: PeriodBounds): boolean {
  return inferAggregateKind(period) === 'period_delta';
}

/** ClickHouse predicate: only period totals enter additive rollups. */
export const PERIOD_DELTA_SQL = `(
  (granularity = 'hour' AND dateDiff('second', period_start, period_end) BETWEEN 1 AND 7200)
  OR (granularity = 'day' AND dateDiff('second', period_start, period_end) BETWEEN 1 AND 172800)
)`;
