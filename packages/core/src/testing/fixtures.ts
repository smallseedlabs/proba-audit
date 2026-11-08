/**
 * Fixtures for contract tests. Pure data builders, no I/O.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  buildAuditEvent,
  type AuditEvent,
  type MetricObservation,
  type StoredAuditEvent,
} from '@smallseedlabs/proba-protocol/audit';

export function randomHash(): string {
  return randomBytes(32).toString('hex');
}

/** A valid StoredAuditEvent. Each call gets fresh ids unless overridden. */
export function makeStoredAuditEvent(overrides: Partial<StoredAuditEvent> = {}): StoredAuditEvent {
  const base = buildAuditEvent({
    traceId: randomUUID(),
    workspaceId: 'seedbed',
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
    occurredAt: '2026-10-25T10:00:00.000Z',
    details: { commandType: 'create_goal' },
  });
  return {
    ...base,
    prevHash: null,
    hash: randomHash(),
    ingestedAt: '2026-10-25T10:00:01.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

/** A valid hourly MetricObservation. */
export function makeObservation(overrides: Partial<MetricObservation> = {}): MetricObservation {
  return {
    version: 1,
    platform: 'meta',
    accountId: 'act_1',
    campaignId: 'cmp_1',
    granularity: 'hour',
    periodStart: '2026-10-25T10:00:00.000Z',
    periodEnd: '2026-10-25T11:00:00.000Z',
    metrics: { impressions: 1000, clicks: 50, spend: 12.5, conversions: 2 },
    currency: 'USD',
    fetchedAt: '2026-10-25T11:05:00.000Z',
    revision: 0,
    ...overrides,
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique name so contract tests never collide on shared Redis/ClickHouse. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Protocol MetricObservation as emitted by Ads PR5 Reddit reports (UTC day, revision 0). */
export function makeAdsObservation(overrides: Partial<MetricObservation> = {}): MetricObservation {
  return {
    version: 1,
    platform: 'reddit',
    accountId: 'a2_testaccount',
    campaignId: 'cmp_metrics',
    granularity: 'day',
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-11-02T00:00:00.000Z',
    metrics: { impressions: 9, clicks: 1, spend: 2, conversions: 0 },
    currency: 'USD',
    fetchedAt: '2026-11-02T00:05:00.000Z',
    timezone: 'UTC',
    revision: 0,
    sourceRef: 'reddit:report:a2_testaccount:cmp_metrics:2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Ads `metrics.ingested` envelope from ad-domain 74d44969 (PR #5): flattened fields plus
 * `details.observations: [MetricObservation]`. event.campaignId is the Proba id.
 */
export function makeAdsMetricsIngestedEvent(
  overrides: Partial<AuditEvent> & { observation?: MetricObservation; probaCampaignId?: string } = {}
): AuditEvent {
  const { observation: observationOverride, probaCampaignId, ...eventOverrides } = overrides;
  const observation = makeAdsObservation(observationOverride);
  return buildAuditEvent({
    traceId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'ws_ads',
    userId: '660e8400-e29b-41d4-a716-446655440001',
    goalId: '770e8400-e29b-41d4-a716-446655440002',
    campaignId: probaCampaignId ?? '11111111-1111-4111-8111-111111111111',
    actor: { type: 'service', id: 'proba-ads' },
    service: 'proba-ads',
    action: 'metrics.ingested',
    category: 'metrics',
    outcome: 'success',
    occurredAt: '2026-11-02T00:05:00.000Z',
    details: {
      platform: observation.platform,
      accountId: observation.accountId,
      campaignId: observation.campaignId,
      granularity: observation.granularity,
      periodStart: observation.periodStart,
      periodEnd: observation.periodEnd,
      impressions: observation.metrics.impressions,
      clicks: observation.metrics.clicks,
      spend: observation.metrics.spend,
      conversions: observation.metrics.conversions,
      currency: observation.currency,
      revision: observation.revision,
      sourceRef: observation.sourceRef,
      observations: [observation],
    },
    ...eventOverrides,
  });
}
