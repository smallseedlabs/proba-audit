/**
 * Project Ads-domain metric audit events into MetricObservations.
 *
 * The producer (ad-domain POST /v1/metrics-fetch) writes protocol AuditEvents to
 * the existing Redis stream `proba.audit.events`. Each `metrics.ingested` event
 * carries a validateMetricObservation-valid observation in `details.observations`
 * (and the same fields flattened). This module is the only place that interprets
 * that envelope. It never calls an ad platform.
 *
 * Inspected from ad-domain @ 74d44969cc4fdf55864ff054a9b2333f0a1d10ab (PR #5):
 *   details.observations[0] = MetricObservation
 *   details.{platform,accountId,campaignId,granularity,periodStart,periodEnd,
 *            impressions,clicks,spend,conversions,currency,revision,sourceRef}
 *   event.campaignId = probaCampaignId (internal)
 *   observation.campaignId = provider campaign id
 * `campaign.metrics_attributed` is a summary (counts/window only) and is not a
 * source of observations. Legacy metrics-ingester summaries ({count,window}) are
 * ignored rather than invented into rows.
 */

import { validateMetricObservation } from '../audit/protocol.js';
import { inferAggregateKind, type AggregateKind } from '../domain/aggregate-kind.js';
import type { AuditEvent } from '../domain/audit.js';
import type { CampaignBinding, MetricObservation, MetricPlatform } from '../domain/metrics.js';

const PROJECT_ACTIONS = new Set(['metrics.ingested', 'metrics.restated', 'metrics.observation_stored']);

const UTC_ZONES = new Set(['UTC', 'Etc/UTC']);

export interface ProjectionIssue {
  reason: string;
  issues: { path: string; message: string }[];
  payload: unknown;
  workspaceId: string;
  platform: string;
  accountId: string;
  /** Audit event id: lineage back to the stream, not a provider run. */
  runId: string;
}

export interface ProjectedObservation {
  workspaceId: string;
  observation: MetricObservation;
  aggregateKind: AggregateKind;
  binding?: CampaignBinding;
  sourceEventId: string;
  sourceTraceId: string;
}

export interface EventProjection {
  /** True when the action is not a metric observation carrier. */
  ignored: boolean;
  observations: ProjectedObservation[];
  quarantined: ProjectionIssue[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function payloadOf(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return '[unserialisable payload]';
  }
}

function isUtcZone(zone: string | undefined): boolean {
  return zone === undefined || UTC_ZONES.has(zone);
}

function issue(
  event: AuditEvent,
  reason: string,
  issues: { path: string; message: string }[],
  payload: unknown,
  extras?: { platform?: string; accountId?: string }
): ProjectionIssue {
  const details = asRecord(event.details) ?? {};
  return {
    reason,
    issues,
    payload: payloadOf(payload),
    workspaceId: event.workspaceId,
    platform: extras?.platform ?? asString(details.platform) ?? 'other',
    accountId: extras?.accountId ?? asString(details.accountId) ?? '',
    runId: event.eventId,
  };
}

function bindingFor(event: AuditEvent, observation: MetricObservation): CampaignBinding | undefined {
  const probaCampaignId = event.campaignId;
  if (!probaCampaignId || probaCampaignId === observation.campaignId) return undefined;
  return {
    workspaceId: event.workspaceId,
    probaCampaignId,
    platform: observation.platform,
    accountId: observation.accountId,
    providerCampaignId: observation.campaignId,
    sourceEventId: event.eventId,
    sourceTraceId: event.traceId,
  };
}

function accept(
  event: AuditEvent,
  observation: MetricObservation,
  quarantined: ProjectionIssue[],
  raw: unknown
): ProjectedObservation | undefined {
  if (!isUtcZone(observation.timezone)) {
    quarantined.push(
      issue(
        event,
        'timezone_not_utc',
        [
          {
            path: 'timezone',
            message: `source timezone "${observation.timezone}" is not UTC; local-midnight bounds are not invented`,
          },
        ],
        raw,
        { platform: observation.platform, accountId: observation.accountId }
      )
    );
    return undefined;
  }
  return {
    workspaceId: event.workspaceId,
    observation,
    aggregateKind: inferAggregateKind(observation),
    binding: bindingFor(event, observation),
    sourceEventId: event.eventId,
    sourceTraceId: event.traceId,
  };
}

function parseOne(event: AuditEvent, value: unknown, quarantined: ProjectionIssue[]): ProjectedObservation | undefined {
  const parsed = validateMetricObservation(value);
  if (!parsed.success) {
    quarantined.push(
      issue(
        event,
        'schema_invalid',
        parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
        value
      )
    );
    return undefined;
  }
  return accept(event, parsed.data as MetricObservation, quarantined, value);
}

/**
 * Rebuild a candidate from the flattened Ads `metrics.ingested` fields when
 * `details.observations` is missing. Never fills conversions (or anything else)
 * with 0: validateMetricObservation decides, and a missing required field
 * quarantines.
 */
function candidateFromFlattened(event: AuditEvent, details: Record<string, unknown>): unknown | undefined {
  const platform = details.platform;
  const accountId = details.accountId;
  const campaignId = details.campaignId;
  const granularity = details.granularity;
  const periodStart = details.periodStart;
  const periodEnd = details.periodEnd;
  const currency = details.currency;
  // Presence of platform/accountId alone is not enough: metrics-ingester summaries
  // carry those plus {count, window}. Ads flattened observations always include
  // campaignId, a period, and metric fields.
  if (
    campaignId === undefined &&
    granularity === undefined &&
    periodStart === undefined &&
    periodEnd === undefined &&
    details.impressions === undefined &&
    details.clicks === undefined &&
    details.spend === undefined &&
    details.conversions === undefined
  ) {
    return undefined;
  }
  const metrics: Record<string, unknown> = {};
  if (details.impressions !== undefined) metrics.impressions = details.impressions;
  if (details.clicks !== undefined) metrics.clicks = details.clicks;
  if (details.spend !== undefined) metrics.spend = details.spend;
  if (details.conversions !== undefined) metrics.conversions = details.conversions;
  if (details.reach !== undefined) metrics.reach = details.reach;
  if (details.videoViews !== undefined) metrics.videoViews = details.videoViews;
  if (details.revenue !== undefined) metrics.revenue = details.revenue;
  return {
    version: 1,
    platform,
    accountId,
    campaignId,
    granularity,
    periodStart,
    periodEnd,
    metrics,
    currency,
    fetchedAt: details.fetchedAt ?? event.occurredAt,
    ...(details.timezone !== undefined ? { timezone: details.timezone } : {}),
    revision: details.revision ?? 0,
    ...(details.sourceRef !== undefined ? { sourceRef: details.sourceRef } : {}),
    ...(details.adsetId !== undefined ? { adsetId: details.adsetId } : {}),
    ...(details.adId !== undefined ? { adId: details.adId } : {}),
  };
}

export function projectMetricAuditEvent(event: AuditEvent): EventProjection {
  if (!PROJECT_ACTIONS.has(event.action)) {
    return { ignored: true, observations: [], quarantined: [] };
  }
  const details = asRecord(event.details) ?? {};
  const quarantined: ProjectionIssue[] = [];
  const observations: ProjectedObservation[] = [];

  const listed = details.observations;
  if (Array.isArray(listed)) {
    if (listed.length === 0) {
      return { ignored: false, observations, quarantined };
    }
    for (const item of listed) {
      const projected = parseOne(event, item, quarantined);
      if (projected) observations.push(projected);
    }
    return { ignored: false, observations, quarantined };
  }

  const flattened = candidateFromFlattened(event, details);
  if (flattened === undefined) {
    // Legacy summary {count, window} from metrics-ingester: not an observation carrier.
    return { ignored: true, observations: [], quarantined: [] };
  }
  const projected = parseOne(event, flattened, quarantined);
  if (projected) observations.push(projected);
  return { ignored: false, observations, quarantined };
}

export function bindingsOf(projected: readonly ProjectedObservation[]): CampaignBinding[] {
  const out: CampaignBinding[] = [];
  const seen = new Set<string>();
  for (const row of projected) {
    const b = row.binding;
    if (!b) continue;
    const key = `${b.workspaceId}|${b.probaCampaignId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

export function isMetricPlatform(value: string): value is MetricPlatform {
  return value === 'meta' || value === 'google' || value === 'reddit' || value === 'x' || value === 'microsoft' || value === 'other';
}
