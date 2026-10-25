/**
 * Pure helpers for UTC time buckets, shared by every MetricsStore adapter so
 * they all roll up identically.
 */

import type { RollupBucket } from './metrics.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function size(bucket: RollupBucket): number {
  return bucket === 'hour' ? HOUR_MS : DAY_MS;
}

/** Start of the UTC bucket containing `iso`. */
export function bucketStart(iso: string, bucket: RollupBucket): string {
  const ms = Date.parse(iso);
  return new Date(Math.floor(ms / size(bucket)) * size(bucket)).toISOString();
}

/** First bucket boundary at or after `iso`. */
export function bucketCeil(iso: string, bucket: RollupBucket): string {
  const ms = Date.parse(iso);
  return new Date(Math.ceil(ms / size(bucket)) * size(bucket)).toISOString();
}

/** Expand [from, to) outwards to whole buckets. */
export function alignWindow(from: string, to: string, bucket: RollupBucket): { from: string; to: string } {
  return { from: bucketStart(from, bucket), to: bucketCeil(to, bucket) };
}
