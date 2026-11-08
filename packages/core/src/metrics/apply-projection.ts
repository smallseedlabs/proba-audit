/**
 * Write projected Ads metric events into the existing MetricsStore / QuarantineStore.
 * Used by the audit-consumer (live stream) and by recover/replay (AuditStore only).
 * Neither path talks to an ad platform.
 */

import type { AuditEvent } from '../domain/audit.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { MetricsStore } from '../ports/metrics-store.js';
import type { QuarantineStore, QuarantinedObservation } from '../ports/quarantine-store.js';
import { bindingsOf, projectMetricAuditEvent, type ProjectedObservation, type ProjectionIssue } from './ads-event-projection.js';

const MAX_PAYLOAD_CHARS = 8_192;

export interface ApplyProjectionDeps {
  metricsStore: MetricsStore;
  quarantine: QuarantineStore;
  ids: IdGenerator;
  clock: Clock;
}

export interface ApplyProjectionResult {
  events: number;
  projected: number;
  quarantined: number;
  written: number;
  skippedStale: number;
  bindings: number;
  ignored: number;
}

function payloadString(value: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(value) ?? '';
  } catch {
    raw = '[unserialisable payload]';
  }
  return raw.length > MAX_PAYLOAD_CHARS ? `${raw.slice(0, MAX_PAYLOAD_CHARS)}…[truncated]` : raw;
}

function toQuarantine(issue: ProjectionIssue, quarantinedAt: string, quarantineId: string): QuarantinedObservation {
  return {
    quarantineId,
    workspaceId: issue.workspaceId,
    platform: issue.platform,
    accountId: issue.accountId,
    runId: issue.runId,
    reason: issue.reason,
    issues: issue.issues,
    payload: payloadString(issue.payload),
    quarantinedAt,
  };
}

export async function applyMetricEventProjection(
  events: readonly AuditEvent[],
  deps: ApplyProjectionDeps
): Promise<ApplyProjectionResult> {
  const result: ApplyProjectionResult = {
    events: events.length,
    projected: 0,
    quarantined: 0,
    written: 0,
    skippedStale: 0,
    bindings: 0,
    ignored: 0,
  };
  const byWorkspace = new Map<string, ProjectedObservation[]>();
  const quarantined: QuarantinedObservation[] = [];
  const now = deps.clock.isoNow();

  for (const event of events) {
    const extracted = projectMetricAuditEvent(event);
    if (extracted.ignored) {
      result.ignored += 1;
      continue;
    }
    for (const row of extracted.observations) {
      const list = byWorkspace.get(row.workspaceId) ?? [];
      list.push(row);
      byWorkspace.set(row.workspaceId, list);
      result.projected += 1;
    }
    for (const item of extracted.quarantined) {
      quarantined.push(toQuarantine(item, now, deps.ids.uuid()));
    }
  }

  if (quarantined.length > 0) {
    await deps.quarantine.add(quarantined);
    result.quarantined = quarantined.length;
  }

  for (const [workspaceId, rows] of byWorkspace) {
    const upsert = await deps.metricsStore.upsertObservations(
      workspaceId,
      rows.map((r) => r.observation)
    );
    result.written += upsert.written;
    result.skippedStale += upsert.skippedStale;
    const bindings = bindingsOf(rows);
    if (bindings.length > 0) {
      await deps.metricsStore.upsertCampaignBindings(bindings);
      result.bindings += bindings.length;
    }
  }

  return result;
}
