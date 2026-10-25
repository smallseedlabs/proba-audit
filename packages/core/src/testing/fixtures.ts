/**
 * Fixtures for contract tests. Pure data builders, no I/O.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  buildAuditEvent,
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
