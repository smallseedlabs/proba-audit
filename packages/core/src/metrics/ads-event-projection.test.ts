import { describe, expect, it } from 'vitest';
import { buildAuditEvent } from '../audit/protocol.js';
import { makeAdsMetricsIngestedEvent, makeAdsObservation, makeObservation } from '../testing/fixtures.js';
import { inferAggregateKind } from '../domain/aggregate-kind.js';
import { bindingsOf, projectMetricAuditEvent } from './ads-event-projection.js';

describe('inferAggregateKind', () => {
  it('treats hour and day windows that match the grain as period deltas', () => {
    expect(inferAggregateKind({ granularity: 'hour', periodStart: '2026-11-01T10:00:00.000Z', periodEnd: '2026-11-01T11:00:00.000Z' })).toBe(
      'period_delta'
    );
    expect(inferAggregateKind({ granularity: 'day', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-11-02T00:00:00.000Z' })).toBe(
      'period_delta'
    );
  });

  it('treats a multi-day window as a cumulative snapshot that must not be summed', () => {
    expect(inferAggregateKind({ granularity: 'day', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-11-08T00:00:00.000Z' })).toBe(
      'cumulative_snapshot'
    );
  });
});

describe('projectMetricAuditEvent (Ads PR5 envelope)', () => {
  it('extracts the protocol observation and the proba↔provider campaign binding', () => {
    const event = makeAdsMetricsIngestedEvent();
    const got = projectMetricAuditEvent(event);
    expect(got.ignored).toBe(false);
    expect(got.quarantined).toEqual([]);
    expect(got.observations).toHaveLength(1);
    expect(got.observations[0]?.observation).toMatchObject({
      platform: 'reddit',
      accountId: 'a2_testaccount',
      campaignId: 'cmp_metrics',
      metrics: { impressions: 9, clicks: 1, spend: 2, conversions: 0 },
      timezone: 'UTC',
      sourceRef: 'reddit:report:a2_testaccount:cmp_metrics:2026-11-01T00:00:00.000Z',
    });
    expect(got.observations[0]?.aggregateKind).toBe('period_delta');
    expect(got.observations[0]?.workspaceId).toBe('ws_ads');
    expect(bindingsOf(got.observations)).toEqual([
      expect.objectContaining({
        workspaceId: 'ws_ads',
        probaCampaignId: '11111111-1111-4111-8111-111111111111',
        providerCampaignId: 'cmp_metrics',
        accountId: 'a2_testaccount',
        platform: 'reddit',
        sourceEventId: event.eventId,
        sourceTraceId: event.traceId,
      }),
    ]);
  });

  it('accepts the flattened Ads fields when observations[] is omitted', () => {
    const event = makeAdsMetricsIngestedEvent();
    const details = { ...(event.details as Record<string, unknown>) };
    delete details.observations;
    const got = projectMetricAuditEvent({ ...event, details });
    expect(got.observations[0]?.observation.metrics.impressions).toBe(9);
    expect(got.quarantined).toEqual([]);
  });

  it('quarantines a missing conversions field and never stores 0', () => {
    const event = makeAdsMetricsIngestedEvent();
    const details = { ...(event.details as Record<string, unknown>) };
    delete details.observations;
    delete details.conversions;
    const got = projectMetricAuditEvent({ ...event, details });
    expect(got.observations).toEqual([]);
    expect(got.quarantined[0]?.reason).toBe('schema_invalid');
    expect(JSON.stringify(got.quarantined[0]?.issues)).toMatch(/conversions/);
  });

  it('quarantines an invalid observations[] item rather than inventing metrics', () => {
    const event = makeAdsMetricsIngestedEvent({
      details: {
        observations: [{ platform: 'reddit', accountId: 'a2_testaccount' }],
      },
    });
    const got = projectMetricAuditEvent(event);
    expect(got.observations).toEqual([]);
    expect(got.quarantined[0]?.reason).toBe('schema_invalid');
  });

  it('quarantines a non-UTC source timezone', () => {
    const observation = makeAdsObservation({ timezone: 'America/New_York' });
    const event = makeAdsMetricsIngestedEvent({ observation });
    const got = projectMetricAuditEvent(event);
    expect(got.observations).toEqual([]);
    expect(got.quarantined[0]?.reason).toBe('timezone_not_utc');
  });

  it('ignores campaign.metrics_attributed and legacy ingest summaries (no invented rows)', () => {
    const attributed = buildAuditEvent({
      traceId: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'ws_ads',
      actor: { type: 'service', id: 'proba-ads' },
      service: 'proba-ads',
      action: 'campaign.metrics_attributed',
      category: 'metrics',
      outcome: 'success',
      occurredAt: '2026-11-02T00:05:00.000Z',
      details: { platform: 'reddit', observationCount: 1, quarantinedCount: 0, pages: 1 },
    });
    expect(projectMetricAuditEvent(attributed).ignored).toBe(true);

    const summary = buildAuditEvent({
      traceId: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'seedbed',
      actor: { type: 'service', id: 'metrics-ingester' },
      service: 'metrics-ingester',
      action: 'metrics.ingested',
      category: 'metrics',
      outcome: 'success',
      occurredAt: '2026-11-02T00:05:00.000Z',
      details: { platform: 'meta', accountId: 'act_1', count: 12, window: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' } },
    });
    expect(projectMetricAuditEvent(summary)).toEqual({ ignored: true, observations: [], quarantined: [] });
  });

  it('marks a long window as a cumulative snapshot', () => {
    const observation = makeObservation({
      granularity: 'day',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
    });
    const event = makeAdsMetricsIngestedEvent({ observation });
    expect(projectMetricAuditEvent(event).observations[0]?.aggregateKind).toBe('cumulative_snapshot');
  });
});
