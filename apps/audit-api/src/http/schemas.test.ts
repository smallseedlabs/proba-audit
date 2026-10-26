import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { API_LIMITS, eventCursor, eventsQuerySchema, parseWith, resolveWindow, traceCursor } from './schemas.js';

const now = new Date('2026-10-26T12:00:00.000Z');
const failure = (fn: () => unknown): ApiError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected an ApiError');
};

describe('parseWith', () => {
  it('coerces and applies defaults', () => {
    const q = parseWith(eventsQuerySchema, { limit: '10', outcome: 'failure' });
    expect(q.limit).toBe(10);
    expect(q.order).toBe('desc');
  });

  it('lists unknown parameters, including a workspace parameter, without echoing values', () => {
    const e = failure(() => parseWith(eventsQuerySchema, { workspaceId: 'someone-elses' }));
    expect(e.statusCode).toBe(400);
    expect(JSON.stringify(e.issues)).toContain('workspaceId');
    expect(JSON.stringify(e.issues)).not.toContain('someone-elses');
  });

  it('caps the page size and the free text length', () => {
    expect(failure(() => parseWith(eventsQuerySchema, { limit: String(API_LIMITS.events.maxPageSize + 1) })).issues?.[0].path).toBe('limit');
    expect(failure(() => parseWith(eventsQuerySchema, { limit: '0' })).statusCode).toBe(400);
    expect(failure(() => parseWith(eventsQuerySchema, { q: 'x'.repeat(500) })).issues?.[0].path).toBe('q');
  });
});

describe('resolveWindow', () => {
  const o = { now, defaultRangeHours: 24, maxRangeDays: 90 };
  it('defaults to the last 24 hours', () => {
    expect(resolveWindow({}, o)).toEqual({ from: '2026-10-25T12:00:00.000Z' });
  });
  it('rejects unordered and over-long ranges', () => {
    expect(failure(() => resolveWindow({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }, o)).issues?.[0].path).toBe('to');
    expect(failure(() => resolveWindow({ from: '2026-01-01T00:00:00.000Z' }, o)).issues?.[0].message).toMatch(/90 days/);
  });
  it('lets an id-anchored lookup omit the range', () => {
    expect(resolveWindow({}, { ...o, anchored: true })).toEqual({});
  });
});

describe('cursors', () => {
  const position = { occurredAt: '2026-10-26T10:00:00.000Z', eventId: '00000000-0000-4000-8000-000000000001' };
  it('round-trips and is URL safe', () => {
    const raw = eventCursor.encode(position, 'desc');
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(eventCursor.decode(raw, 'desc')).toEqual(position);
    const t = traceCursor.encode({ lastEventAt: position.occurredAt, traceId: position.eventId });
    expect(traceCursor.decode(t)).toEqual({ lastEventAt: position.occurredAt, traceId: position.eventId });
  });
  it('rejects garbage, forged shapes and the other order', () => {
    for (const bad of ['', '!!!', Buffer.from('{"t":"x"}').toString('base64url'), Buffer.from('[]').toString('base64url')]) {
      expect(failure(() => eventCursor.decode(bad, 'desc')).code).toBe('invalid_cursor');
    }
    expect(failure(() => eventCursor.decode(eventCursor.encode(position, 'asc'), 'desc')).code).toBe('invalid_cursor');
  });
});
