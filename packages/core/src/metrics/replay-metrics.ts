/**
 * Rebuild metric observations from the durable audit log. Reads AuditStore only.
 * Never publishes, never calls an ad platform, never opens a provider HTTP client.
 *
 * Use this after a consumer crash between the audit write and the metrics write,
 * or to recover a workspace onto a fresh MetricsStore from `audit_events`.
 */

import type { AuditEvent, StoredAuditEvent } from '../domain/audit.js';
import type { AuditStore } from '../ports/audit-store.js';
import type { MetricsStore } from '../ports/metrics-store.js';
import { applyMetricEventProjection, type ApplyProjectionDeps, type ApplyProjectionResult } from './apply-projection.js';

export interface ReplayMetricsRequest {
  workspaceId: string;
  /** Inclusive occurredAt (UTC ISO Z). Omit to read from the beginning. */
  from?: string;
  /** Exclusive occurredAt. Omit to read through now. */
  to?: string;
  /** After projecting, recompute rollups for the span that changed. Default false. */
  computeRollups?: boolean;
}

export interface ReplayMetricsResult extends ApplyProjectionResult {
  scanned: number;
  rollupRows: number;
}

const PAGE = 200;
const PROJECT_ACTIONS = ['metrics.ingested', 'metrics.restated', 'metrics.observation_stored'] as const;

function asAuditEvent(stored: StoredAuditEvent): AuditEvent {
  const {
    prevHash: _prevHash,
    hash: _hash,
    ingestedAt: _ingestedAt,
    schemaVersion: _schemaVersion,
    contentDigest: _contentDigest,
    ...event
  } = stored;
  void _prevHash;
  void _hash;
  void _ingestedAt;
  void _schemaVersion;
  void _contentDigest;
  return event;
}

export async function replayMetricsFromAudit(
  auditStore: AuditStore,
  deps: ApplyProjectionDeps & { metricsStore: MetricsStore },
  request: ReplayMetricsRequest
): Promise<ReplayMetricsResult> {
  const collected: AuditEvent[] = [];
  for (const action of PROJECT_ACTIONS) {
    let after: { occurredAt: string; eventId: string } | undefined;
    for (;;) {
      const page = await auditStore.search({
        workspaceId: request.workspaceId,
        action,
        ...(request.from ? { from: request.from } : {}),
        ...(request.to ? { to: request.to } : {}),
        order: 'asc',
        limit: PAGE,
        ...(after ? { after } : {}),
      });
      for (const event of page.events) collected.push(asAuditEvent(event));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
  }

  const applied = await applyMetricEventProjection(collected, deps);
  let rollupRows = 0;
  if (request.computeRollups) {
    const changed = await deps.metricsStore.changedSince(request.workspaceId);
    if (changed) {
      rollupRows += await deps.metricsStore.computeRollups({
        workspaceId: request.workspaceId,
        bucket: 'hour',
        from: changed.from,
        to: changed.to,
      });
      rollupRows += await deps.metricsStore.computeRollups({
        workspaceId: request.workspaceId,
        bucket: 'day',
        from: changed.from,
        to: changed.to,
      });
    }
  }
  return { ...applied, scanned: collected.length, rollupRows };
}
