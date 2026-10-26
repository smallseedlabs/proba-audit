import type { ClickHouseClient } from '@clickhouse/client';
import type { AuditContentStore, StoredAuditContent } from '@smallseedlabs/proba-audit-core';

interface ContentRow {
  workspace_id: string;
  event_id: string;
  occurred_at: string;
  kind: string;
  text: string;
  truncated: number;
  original_length: number;
  redactions: number;
  content_digest: string;
}

export function toContentRow(c: StoredAuditContent): ContentRow {
  return {
    workspace_id: c.workspaceId,
    event_id: c.eventId,
    occurred_at: c.occurredAt,
    kind: c.content.kind,
    text: c.content.text,
    truncated: c.content.truncated ? 1 : 0,
    original_length: c.content.originalLength,
    redactions: c.content.redactions,
    content_digest: c.contentDigest,
  };
}

export function fromContentRow(r: ContentRow): StoredAuditContent {
  return {
    workspaceId: r.workspace_id,
    eventId: r.event_id,
    occurredAt: r.occurred_at,
    content: {
      kind: r.kind,
      text: r.text,
      truncated: Number(r.truncated) === 1,
      originalLength: Number(r.original_length),
      redactions: Number(r.redactions),
    },
    contentDigest: r.content_digest,
  };
}

export interface ClickHouseAuditContentStoreOptions {
  client: ClickHouseClient;
  ownsClient?: boolean;
}

/**
 * AuditContentStore on ClickHouse (table `audit_event_content`, migration 0008): ReplacingMergeTree
 * keyed by (workspace, event), read with FINAL so a re-put of the same event reads as one row.
 * Its own table, so it can have its own TTL / partition drops and its own grants.
 */
export class ClickHouseAuditContentStore implements AuditContentStore {
  private readonly client: ClickHouseClient;
  private readonly ownsClient: boolean;

  constructor(options: ClickHouseAuditContentStoreOptions) {
    this.client = options.client;
    this.ownsClient = options.ownsClient ?? false;
  }

  async put(items: StoredAuditContent[]): Promise<void> {
    if (items.length === 0) return;
    await this.client.insert({ table: 'audit_event_content', values: items.map(toContentRow), format: 'JSONEachRow' });
  }

  async get(workspaceId: string, eventId: string): Promise<StoredAuditContent | null> {
    const [row] = await this.getMany(workspaceId, [eventId]);
    return row ?? null;
  }

  async getMany(workspaceId: string, eventIds: string[]): Promise<StoredAuditContent[]> {
    if (eventIds.length === 0) return [];
    const rs = await this.client.query({
      query: `SELECT workspace_id, event_id, occurred_at, kind, text, truncated, original_length, redactions, content_digest
              FROM audit_event_content FINAL
              WHERE workspace_id = {workspaceId:String} AND event_id IN {ids:Array(UUID)}`,
      query_params: { workspaceId, ids: [...new Set(eventIds)] },
      format: 'JSONEachRow',
    });
    return (await rs.json<ContentRow>()).map(fromContentRow);
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.close();
  }
}
