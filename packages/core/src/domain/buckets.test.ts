import { describe, expect, it } from 'vitest';
import { alignWindow, bucketCeil, bucketStart } from './buckets.js';

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
