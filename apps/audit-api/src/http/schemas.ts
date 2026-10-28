/**
 * Query-parameter schemas of the read API. Every route parses its query through one of these:
 * unknown parameters are rejected (so nobody can pass a workspaceId or any other scope), every
 * string is bounded, every list is capped. The workspace never appears here: it comes from the
 * authenticated session.
 */

import { z } from 'zod';
import {
  auditActorTypeSchema,
  auditCategorySchema,
  auditOutcomeSchema,
  auditRiskLevelSchema,
} from '@smallseedlabs/proba-protocol/audit';
import type { AuditCursor, TraceCursor } from '@smallseedlabs/proba-audit-core';
import { ApiError } from './errors.js';

/** Caps of the API. Exported so docs, the portal and tests agree with the code. */
export const API_LIMITS = {
  events: { defaultPageSize: 50, maxPageSize: 200, maxRangeDays: 90, defaultRangeHours: 24 },
  traces: { defaultPageSize: 25, maxPageSize: 100, maxRangeDays: 7, defaultRangeHours: 24 },
  facets: { defaultValues: 50, maxValues: 100, maxRangeDays: 90, defaultRangeHours: 24 * 7 },
  campaigns: { defaultRows: 20, maxRows: 100 },
  /** The `context-reader` role: smaller pages, shorter default look-back. */
  contextReader: { defaultPageSize: 25, maxPageSize: 100, maxRangeDays: 90, defaultRangeHours: 24 * 7 },
  contextReaderTraces: { defaultPageSize: 25, maxPageSize: 50, maxRangeDays: 7, defaultRangeHours: 24 },
  text: { min: 2, max: 100 },
  idMaxLength: 128,
  cursorMaxLength: 512,
  /** Events loaded for one trace; a longer trace is cut and marked truncated. */
  traceMaxEvents: 1000,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const isoUtc = z
  .string()
  .datetime({ message: 'must be an ISO 8601 UTC timestamp ending in Z, for example 2026-10-25T10:00:00Z' })
  .transform((v) => new Date(v).toISOString());
const uuid = z.string().uuid().transform((v) => v.toLowerCase());
const token = (max = 128) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_.:@/-]+$/, 'letters, digits and _ . : @ / - only');
const campaignId = z.string().min(1).max(API_LIMITS.idMaxLength).regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits and _ . : - only');
const limit = (def: number, max: number) =>
  z.coerce.number().int().min(1, 'must be at least 1').max(max, `at most ${max}`).default(def);
const cursor = z.string().min(1).max(API_LIMITS.cursorMaxLength);
const granularity = z.enum(['hour', 'day']);

export const eventsQuerySchema = z
  .object({
    from: isoUtc.optional(),
    to: isoUtc.optional(),
    traceId: uuid.optional(),
    /** Id of the actor (a user, a service, the brain). */
    actor: z.string().min(1).max(API_LIMITS.idMaxLength).optional(),
    actorType: auditActorTypeSchema.optional(),
    service: token(64).optional(),
    action: z.string().min(1).max(API_LIMITS.idMaxLength).regex(/^[a-z0-9_.-]+$/, 'lower-case dotted action name').optional(),
    category: auditCategorySchema.optional(),
    outcome: auditOutcomeSchema.optional(),
    riskLevel: auditRiskLevelSchema.optional(),
    goalId: uuid.optional(),
    threadId: uuid.optional(),
    campaignId: campaignId.optional(),
    /** Free text on action and target. */
    q: z.string().trim().min(API_LIMITS.text.min).max(API_LIMITS.text.max).optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: limit(API_LIMITS.events.defaultPageSize, API_LIMITS.events.maxPageSize),
    cursor: cursor.optional(),
  })
  .strict();
export type EventsQuery = z.output<typeof eventsQuerySchema>;

/**
 * The `context-reader` role's own parameters (its `actorId` and `workspaceId` are taken off the query before it is parsed:
 * they are checked against the assertion, see `readActAsParams`). Text is never searched, and the actor is not a filter:
 * it is always the user the call acts for.
 */
export const contextEventsQuerySchema = z
  .object({
    goalId: uuid.optional(),
    /** Only actions that start with this, for example `goal.` or `campaign.`. */
    actionPrefix: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/, 'lower-case dotted action name prefix').optional(),
    /** Events at or after this moment. Without it, the last 7 days (a goal lookup needs no range). */
    since: isoUtc.optional(),
    limit: limit(API_LIMITS.contextReader.defaultPageSize, API_LIMITS.contextReader.maxPageSize),
    cursor: cursor.optional(),
  })
  .strict();
export type ContextEventsQuery = z.output<typeof contextEventsQuerySchema>;

export const contextTracesQuerySchema = z
  .object({
    since: isoUtc.optional(),
    limit: limit(API_LIMITS.contextReaderTraces.defaultPageSize, API_LIMITS.contextReaderTraces.maxPageSize),
    cursor: cursor.optional(),
  })
  .strict();
export type ContextTracesQuery = z.output<typeof contextTracesQuerySchema>;

/** The two parameters every `context-reader` call carries; checked against the assertion before any route runs. */
export const actAsParamsSchema = z.object({ actorId: z.string().min(1).max(API_LIMITS.idMaxLength), workspaceId: z.string().min(1).max(API_LIMITS.idMaxLength) });

export const tracesQuerySchema = z
  .object({
    from: isoUtc.optional(),
    to: isoUtc.optional(),
    limit: limit(API_LIMITS.traces.defaultPageSize, API_LIMITS.traces.maxPageSize),
    cursor: cursor.optional(),
  })
  .strict();
export type TracesQuery = z.output<typeof tracesQuerySchema>;

export const facetsQuerySchema = z
  .object({
    from: isoUtc.optional(),
    to: isoUtc.optional(),
    limit: limit(API_LIMITS.facets.defaultValues, API_LIMITS.facets.maxValues),
  })
  .strict();
export type FacetsQuery = z.output<typeof facetsQuerySchema>;

export const chainQuerySchema = z.object({ from: isoUtc, to: isoUtc }).strict();
export type ChainQuery = z.output<typeof chainQuerySchema>;

export const summaryQuerySchema = z
  .object({ from: isoUtc, to: isoUtc, granularity: granularity.default('day'), campaignId: campaignId.optional() })
  .strict();
export type SummaryQueryParams = z.output<typeof summaryQuerySchema>;

export const compareQuerySchema = z
  .object({
    granularity: granularity.default('day'),
    currentFrom: isoUtc,
    currentTo: isoUtc,
    previousFrom: isoUtc.optional(),
    previousTo: isoUtc.optional(),
    campaignId: campaignId.optional(),
  })
  .strict()
  .refine((q) => (q.previousFrom === undefined) === (q.previousTo === undefined), {
    message: 'previousFrom and previousTo go together',
    path: ['previousFrom'],
  });
export type CompareQueryParams = z.output<typeof compareQuerySchema>;

export const campaignsQuerySchema = z
  .object({
    from: isoUtc,
    to: isoUtc,
    granularity: granularity.default('day'),
    limit: limit(API_LIMITS.campaigns.defaultRows, API_LIMITS.campaigns.maxRows),
  })
  .strict();
export type CampaignsQuery = z.output<typeof campaignsQuerySchema>;

export const noQuerySchema = z.object({}).strict();
export const eventParamsSchema = z.object({ eventId: uuid }).strict();
export const traceParamsSchema = z.object({ traceId: uuid }).strict();

/** Parse `input` or throw a 400 naming every problem (parameter path and message, never the value). */
export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown, what: 'query' | 'path' = 'query'): z.output<S> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw new ApiError(
    400,
    what === 'query' ? 'invalid_query' : 'invalid_path',
    `Some ${what === 'query' ? 'query parameters' : 'path parameters'} are not valid.`,
    parsed.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.code === 'unrecognized_keys' ? `unknown parameter: ${i.keys.join(', ')}` : i.message,
    }))
  );
}

export interface TimeWindow {
  from?: string;
  to?: string;
}

/**
 * Resolve the time range of a list request. With neither bound the last `defaultRangeHours` are
 * used. A lookup anchored on an id (trace, goal, thread) may omit the range: those columns have their
 * own indexes. Ranges are ordered and no longer than `maxRangeDays`.
 */
export function resolveWindow(
  q: TimeWindow,
  options: { now: Date; defaultRangeHours: number; maxRangeDays: number; anchored?: boolean }
): TimeWindow {
  const now = options.now.getTime();
  let from = q.from === undefined ? undefined : Date.parse(q.from);
  const to = q.to === undefined ? undefined : Date.parse(q.to);
  const issues: { path: string; message: string }[] = [];
  if (from !== undefined && to !== undefined && !(from < to)) issues.push({ path: 'to', message: 'must be after from' });
  if (from === undefined && !options.anchored) from = (to ?? now) - options.defaultRangeHours * HOUR_MS;
  if (from !== undefined && (to ?? now) - from > options.maxRangeDays * DAY_MS && !(options.anchored && q.from === undefined)) {
    issues.push({ path: q.from === undefined ? 'to' : 'from', message: `the range is longer than ${options.maxRangeDays} days` });
  }
  if (issues.length > 0) throw new ApiError(400, 'invalid_query', 'The time range is not valid.', issues);
  return {
    ...(from !== undefined ? { from: new Date(from).toISOString() } : {}),
    ...(to !== undefined ? { to: new Date(to).toISOString() } : {}),
  };
}

const cursorBody = z.object({ t: z.string().datetime(), i: z.string().uuid(), o: z.enum(['asc', 'desc']).optional() }).strict();

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function decode(raw: string): z.output<typeof cursorBody> {
  try {
    const parsed = cursorBody.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid. Start again from the first page.', [{ path: 'cursor', message: 'not a cursor issued by this API' }]);
}

/**
 * Cursors are opaque, URL-safe and carry only a sort position (and the order they were issued for).
 * They grant no access: the workspace and every filter are applied again on each request.
 */
export const eventCursor = {
  encode: (c: AuditCursor, order: 'asc' | 'desc'): string => encode({ t: c.occurredAt, i: c.eventId, o: order }),
  decode(raw: string, order: 'asc' | 'desc'): AuditCursor {
    const c = decode(raw);
    if (c.o !== order) throw new ApiError(400, 'invalid_cursor', 'The cursor belongs to a different sort order.', [{ path: 'cursor', message: 'issued for another order' }]);
    return { occurredAt: new Date(c.t).toISOString(), eventId: c.i.toLowerCase() };
  },
};

export const traceCursor = {
  encode: (c: TraceCursor): string => encode({ t: c.lastEventAt, i: c.traceId }),
  decode(raw: string): TraceCursor {
    const c = decode(raw);
    return { lastEventAt: new Date(c.t).toISOString(), traceId: c.i.toLowerCase() };
  },
};
