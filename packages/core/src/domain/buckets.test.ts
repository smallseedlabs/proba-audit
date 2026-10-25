import { describe, expect, it } from 'vitest';
import { dayBucket, nextDayStart, tzOffsetMs, alignWindow, bucketCeil, bucketStart } from './buckets.js';

describe('buckets', () => {
  it('floors to UTC hour and day', () => {
    expect(bucketStart('2026-10-25T10:59:59.999Z', 'hour')).toBe('2026-10-25T10:00:00.000Z');
    expect(bucketStart('2026-10-25T23:30:00.000Z', 'day')).toBe('2026-10-25T00:00:00.000Z');
  });

  it('ceils to the next boundary and leaves boundaries alone', () => {
    expect(bucketCeil('2026-10-25T10:00:00.001Z', 'hour')).toBe('2026-10-25T11:00:00.000Z');
    expect(bucketCeil('2026-10-25T11:00:00.000Z', 'hour')).toBe('2026-10-25T11:00:00.000Z');
    expect(bucketCeil('2026-10-25T00:30:00.000Z', 'day')).toBe('2026-10-26T00:00:00.000Z');
  });

  it('aligns a window outwards to whole buckets', () => {
    expect(alignWindow('2026-10-25T10:30:00.000Z', '2026-10-25T12:10:00.000Z', 'hour')).toEqual({
      from: '2026-10-25T10:00:00.000Z',
      to: '2026-10-25T13:00:00.000Z',
    });
  });
});

describe('local day buckets', () => {
  it('is the UTC day for UTC', () => {
    expect(dayBucket('2026-10-25T23:30:00.000Z', 'UTC')).toEqual({ start: '2026-10-25T00:00:00.000Z', date: '2026-10-25' });
    expect(dayBucket('2026-10-25T23:30:00.000Z')).toEqual({ start: '2026-10-25T00:00:00.000Z', date: '2026-10-25' });
  });

  it('cuts at local midnight for zones east and west of UTC, including half-hour offsets', () => {
    expect(dayBucket('2026-10-25T19:00:00.000Z', 'Asia/Kolkata')).toEqual({ start: '2026-10-25T18:30:00.000Z', date: '2026-10-26' });
    expect(dayBucket('2026-10-25T18:00:00.000Z', 'Asia/Kolkata')).toEqual({ start: '2026-10-24T18:30:00.000Z', date: '2026-10-25' });
    expect(dayBucket('2026-07-01T03:00:00.000Z', 'America/New_York')).toEqual({ start: '2026-06-30T04:00:00.000Z', date: '2026-06-30' });
  });

  it('follows daylight saving: 23, 24 and 25 hour days', () => {
    // London springs forward on 2026-03-29 and falls back on 2026-10-25.
    const spring = dayBucket('2026-03-29T12:00:00.000Z', 'Europe/London').start;
    expect(nextDayStart(spring, 'Europe/London')).toBe('2026-03-29T23:00:00.000Z');
    expect(Date.parse(nextDayStart(spring, 'Europe/London')) - Date.parse(spring)).toBe(23 * 3_600_000);
    const autumn = dayBucket('2026-10-25T12:00:00.000Z', 'Europe/London').start;
    expect(autumn).toBe('2026-10-24T23:00:00.000Z');
    expect(Date.parse(nextDayStart(autumn, 'Europe/London')) - Date.parse(autumn)).toBe(25 * 3_600_000);
    const normal = dayBucket('2026-11-10T12:00:00.000Z', 'Europe/London').start;
    expect(Date.parse(nextDayStart(normal, 'Europe/London')) - Date.parse(normal)).toBe(24 * 3_600_000);
  });

  it('reports the zone offset in milliseconds', () => {
    expect(tzOffsetMs(Date.parse('2026-07-01T00:00:00.000Z'), 'Europe/London')).toBe(3_600_000);
    expect(tzOffsetMs(Date.parse('2026-12-01T00:00:00.000Z'), 'Europe/London')).toBe(0);
    expect(tzOffsetMs(Date.parse('2026-12-01T00:00:00.000Z'), 'Asia/Kolkata')).toBe(19_800_000);
  });
});
