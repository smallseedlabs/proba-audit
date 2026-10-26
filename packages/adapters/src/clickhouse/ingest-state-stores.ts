import type { ClickHouseClient } from '@clickhouse/client';
import type {
  Checkpoint,
  CheckpointKey,
  CheckpointStore,
  Clock,
  QuarantinedObservation,
  QuarantineQuery,
  QuarantineStore,
} from '@smallseedlabs/proba-audit-core';
import { SystemClock } from '../runtime/system.js';

export interface ClickHouseStateStoreOptions {
  client: ClickHouseClient;
  clock?: Clock;
  ownsClient?: boolean;
}

interface CheckpointRow {
  workspace_id: string;
  source: string;
  account_id: string;
  stream: string;
  cursor: string;
  run_id: string;
  updated_at: string;
}

const KEY_PARAMS = (k: CheckpointKey) => ({ w: k.workspaceId, s: k.source, a: k.accountId, st: k.stream });
const KEY_WHERE = 'workspace_id = {w:String} AND source = {s:String} AND account_id = {a:String} AND stream = {st:String}';

/**
 * CheckpointStore on ClickHouse (table ingest_checkpoints, migration 0005):
 * ReplacingMergeTree(updated_at), read with FINAL, so the latest write per key wins.
 * No new datastore: ingestion state lives next to the data it describes.
 */
export class ClickHouseCheckpointStore implements CheckpointStore {
  private readonly client: ClickHouseClient;
  private readonly clock: Clock;
  private readonly ownsClient: boolean;

  constructor(options: ClickHouseStateStoreOptions) {
    this.client = options.client;
    this.clock = options.clock ?? new SystemClock();
    this.ownsClient = options.ownsClient ?? false;
  }

  async get(key: CheckpointKey): Promise<Checkpoint | null> {
    const rs = await this.client.query({
      query: `SELECT * FROM ingest_checkpoints FINAL WHERE ${KEY_WHERE} LIMIT 1`,
      query_params: KEY_PARAMS(key),
      format: 'JSONEachRow',
    });
    const [row] = await rs.json<CheckpointRow>();
    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      source: row.source,
      accountId: row.account_id,
      stream: row.stream,
      cursor: row.cursor,
      runId: row.run_id,
      updatedAt: row.updated_at,
    };
  }

  async set(key: CheckpointKey, value: { cursor: string; runId: string }): Promise<Checkpoint> {
    const updatedAt = this.clock.isoNow();
    const row: CheckpointRow = {
      workspace_id: key.workspaceId,
      source: key.source,
      account_id: key.accountId,
      stream: key.stream,
      cursor: value.cursor,
      run_id: value.runId,
      updated_at: updatedAt,
    };
    await this.client.insert({ table: 'ingest_checkpoints', values: [row], format: 'JSONEachRow' });
    return { ...key, cursor: value.cursor, runId: value.runId, updatedAt };
  }

  async delete(key: CheckpointKey): Promise<void> {
    await this.client.command({
      query: `DELETE FROM ingest_checkpoints WHERE ${KEY_WHERE}`,
      query_params: KEY_PARAMS(key),
      clickhouse_settings: { mutations_sync: '2' },
    });
  }

  async ping(): Promise<void> {
    const result = await this.client.ping();
    if (!result.success) throw result.error;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }
}

interface QuarantineRow {
  quarantine_id: string;
  workspace_id: string;
  platform: string;
  account_id: string;
  run_id: string;
  reason: string;
  issues: string;
  payload: string;
  quarantined_at: string;
}

/** QuarantineStore on ClickHouse (table metric_observation_quarantine, migration 0005, 90 day TTL). */
export class ClickHouseQuarantineStore implements QuarantineStore {
  private readonly client: ClickHouseClient;
  private readonly ownsClient: boolean;

  constructor(options: ClickHouseStateStoreOptions) {
    this.client = options.client;
    this.ownsClient = options.ownsClient ?? false;
  }

  async add(entries: QuarantinedObservation[]): Promise<void> {
    if (entries.length === 0) return;
    const values: QuarantineRow[] = entries.map((e) => ({
      quarantine_id: e.quarantineId,
      workspace_id: e.workspaceId,
      platform: e.platform,
      account_id: e.accountId,
      run_id: e.runId,
      reason: e.reason,
      issues: JSON.stringify(e.issues),
      payload: e.payload,
      quarantined_at: e.quarantinedAt,
    }));
    await this.client.insert({ table: 'metric_observation_quarantine', values, format: 'JSONEachRow' });
  }

  async list(query: QuarantineQuery = {}): Promise<QuarantinedObservation[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: Math.min(query.limit ?? 100, 10_000) };
    const eq = (column: string, name: string, value: string | undefined): void => {
      if (value === undefined) return;
      clauses.push(`${column} = {${name}:String}`);
      params[name] = value;
    };
    eq('workspace_id', 'w', query.workspaceId);
    eq('platform', 'p', query.platform);
    eq('account_id', 'a', query.accountId);
    eq('run_id', 'r', query.runId);
    const rs = await this.client.query({
      query: `SELECT * FROM metric_observation_quarantine ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
              ORDER BY quarantined_at DESC, quarantine_id ASC LIMIT {limit:UInt32}`,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = await rs.json<QuarantineRow>();
    return rows.map((r) => ({
      quarantineId: r.quarantine_id,
      workspaceId: r.workspace_id,
      platform: r.platform,
      accountId: r.account_id,
      runId: r.run_id,
      reason: r.reason,
      issues: JSON.parse(r.issues) as QuarantinedObservation['issues'],
      payload: r.payload,
      quarantinedAt: r.quarantined_at,
    }));
  }

  async ping(): Promise<void> {
    const result = await this.client.ping();
    if (!result.success) throw result.error;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }
}
