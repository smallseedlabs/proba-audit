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

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Calendar fields of an instant as seen in `timeZone`. */
export function localParts(ms: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second };
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds (positive east of UTC). */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

export interface DayBucket {
  /** UTC instant of local midnight (ISO). */
  start: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
}

/**
 * The local day (in `timeZone`) that contains `iso`: its start as a UTC instant
 * and its calendar date. DST days are 23 or 25 hours long. Use 'UTC' for UTC days.
 */
export function dayBucket(iso: string, timeZone = 'UTC'): DayBucket {
  const ms = Date.parse(iso);
  const p = localParts(ms, timeZone);
  const localMidnight = Date.UTC(p.y, p.m - 1, p.d);
  // Find the instant whose local clock reads 00:00; re-check the offset once for DST changes.
  let start = localMidnight - tzOffsetMs(localMidnight, timeZone);
  const second = localMidnight - tzOffsetMs(start, timeZone);
  if (second !== start) start = second;
  const date = `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return { start: new Date(start).toISOString(), date };
}

/** Start of the local day after the one starting at `startIso`. */
export function nextDayStart(startIso: string, timeZone = 'UTC'): string {
  // 36 hours after local midnight is always inside the next local day (days are 23 to 25 hours).
  return dayBucket(new Date(Date.parse(startIso) + 36 * HOUR_MS).toISOString(), timeZone).start;
}
