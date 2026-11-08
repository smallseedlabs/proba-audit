import { describe, expect, it } from 'vitest';
import { applyMetricEventProjection, chainEvent, replayMetricsFromAudit } from '@smallseedlabs/proba-audit-core';
import { makeAdsMetricsIngestedEvent, makeAdsObservation } from '@smallseedlabs/proba-audit-core/testing';
import { InMemoryAuditStore } from './audit-store.js';
import { ManualClock, SequentialIdGenerator } from './clock-ids.js';
import { InMemoryMetricsStore } from './metrics-store.js';
import { InMemoryQuarantineStore } from './quarantine-store.js';

function deps() {
  return {
    metricsStore: new InMemoryMetricsStore(),
    quarantine: new InMemoryQuarantineStore(),
    ids: new SequentialIdGenerator(),
    clock: new ManualClock('2026-11-02T00:06:00.000Z'),
  };
}

describe('applyMetricEventProjection', () => {
  it('upserts Ads observations idempotently and does not double-count a replay', async () => {
    const d = deps();
    const event = makeAdsMetricsIngestedEvent();
    const first = await applyMetricEventProjection([event], d);
    expect(first.written).toBe(1);
    expect(first.bindings).toBe(1);
    const second = await applyMetricEventProjection([event, event], d);
    expect(second.written).toBe(1);
    expect(second.skippedStale).toBe(0);
    const rows = await d.metricsStore.queryObservations({ workspaceId: 'ws_ads' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metrics.impressions).toBe(9);
    expect(await d.metricsStore.resolveCampaignIds('ws_ads', ['11111111-1111-4111-8111-111111111111'])).toEqual(['cmp_metrics']);
  });

  it('applies a higher revision as a restatement, not a sum', async () => {
    const d = deps();
    const first = makeAdsMetricsIngestedEvent();
    const restated = makeAdsMetricsIngestedEvent({
      observation: makeAdsObservation({ revision: 1, metrics: { impressions: 11, clicks: 2, spend: 3, conversions: 1 } }),
    });
    await applyMetricEventProjection([first], d);
    await applyMetricEventProjection([restated], d);
    const rows = await d.metricsStore.queryObservations({ workspaceId: 'ws_ads' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metrics).toEqual({ impressions: 11, clicks: 2, spend: 3, conversions: 1 });
    expect(rows[0]?.revision).toBe(1);
  });

  it('ignores an out-of-order stale revision', async () => {
    const d = deps();
    const high = makeAdsMetricsIngestedEvent({
      observation: makeAdsObservation({ revision: 2, metrics: { impressions: 20, clicks: 2, spend: 4, conversions: 1 } }),
    });
    const stale = makeAdsMetricsIngestedEvent({
      observation: makeAdsObservation({ revision: 1, metrics: { impressions: 1, clicks: 0, spend: 0, conversions: 0 } }),
    });
    await applyMetricEventProjection([high], d);
    const result = await applyMetricEventProjection([stale], d);
    expect(result.skippedStale).toBe(1);
    expect((await d.metricsStore.queryObservations({ workspaceId: 'ws_ads' }))[0]?.metrics.impressions).toBe(20);
  });

  it('quarantines malformed rows into the existing quarantine store', async () => {
    const d = deps();
    const bad = makeAdsMetricsIngestedEvent({ details: { observations: [{ platform: 'reddit' }] } });
    const result = await applyMetricEventProjection([bad], d);
    expect(result.projected).toBe(0);
    expect(result.quarantined).toBe(1);
    expect(await d.metricsStore.queryObservations({ workspaceId: 'ws_ads' })).toEqual([]);
    const held = await d.quarantine.list({ workspaceId: 'ws_ads' });
    expect(held[0]?.reason).toBe('schema_invalid');
    expect(held[0]?.runId).toBe(bad.eventId);
  });

  it('keeps two workspaces isolated', async () => {
    const d = deps();
    await applyMetricEventProjection(
      [
        makeAdsMetricsIngestedEvent({
          workspaceId: 'ws_a',
          observation: makeAdsObservation({ metrics: { impressions: 1, clicks: 0, spend: 0, conversions: 0 } }),
        }),
        makeAdsMetricsIngestedEvent({
          workspaceId: 'ws_b',
          observation: makeAdsObservation({ metrics: { impressions: 9, clicks: 1, spend: 2, conversions: 0 } }),
        }),
      ],
      d
    );
    expect((await d.metricsStore.queryObservations({ workspaceId: 'ws_a' }))[0]?.metrics.impressions).toBe(1);
    expect((await d.metricsStore.queryObservations({ workspaceId: 'ws_b' }))[0]?.metrics.impressions).toBe(9);
  });
});

describe('replayMetricsFromAudit', () => {
  it('rebuilds observations from the audit log without a bus or provider', async () => {
    const d = deps();
    const audit = new InMemoryAuditStore();
    const event = makeAdsMetricsIngestedEvent();
    await audit.appendBatch([chainEvent(event, null, '2026-11-02T00:06:00.000Z')]);
    const result = await replayMetricsFromAudit(audit, d, { workspaceId: 'ws_ads', computeRollups: true });
    expect(result.scanned).toBe(1);
    expect(result.written).toBe(1);
    expect(result.rollupRows).toBeGreaterThan(0);
    expect((await d.metricsStore.queryObservations({ workspaceId: 'ws_ads' }))[0]?.metrics.impressions).toBe(9);
  });
});
