import pg from 'pg';
import {
  AnchorTamperedError,
  signAnchor,
  verifyAnchorSignature,
  type AnchorStore,
  type ChainAnchor,
  type ChainAnchorClaim,
} from '@smallseedlabs/proba-audit-core';

export interface PostgresAnchorStoreOptions {
  /** Connection string. Ignored when `pool` is given. */
  connectionString?: string;
  /** Reuse an existing pool (the store then never closes it). */
  pool?: pg.Pool;
  hmacKey: string;
  /** Table name. Default 'audit_chain_anchors'. Must be a plain identifier. */
  table?: string;
}

/** Mirrors migrations/postgres/0002_audit_chain_anchors.sql (a test keeps them equal). The runtime images do not ship the migration files. */
export const ANCHOR_TABLE_DDL = `CREATE TABLE IF NOT EXISTS audit_chain_anchors (
  workspace_id TEXT        PRIMARY KEY,
  head_hash    TEXT        NOT NULL,
  count        BIGINT      NOT NULL CHECK (count >= 0),
  anchored_at  TEXT        NOT NULL,
  signature    TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

interface AnchorRow {
  workspace_id: string;
  head_hash: string;
  count: string | number;
  anchored_at: string;
  signature: string;
}

const fromRow = (r: AnchorRow): ChainAnchor => ({
  workspaceId: r.workspace_id,
  headHash: r.head_hash,
  count: Number(r.count),
  timestamp: r.anchored_at,
  signature: r.signature,
});

/**
 * AnchorStore on Postgres. The table is created on first use (idempotent), so the process needs no separate migration step
 * (the same SQL is in migrations/postgres/0002_audit_chain_anchors.sql for those who apply schema by hand). One row per
 * workspace; an upsert only replaces a row whose `count` is not higher, so an anchor never goes backwards even with
 * two writers racing.
 */
export class PostgresAnchorStore implements AnchorStore {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly table: string;
  private readonly key: string;
  private schema?: Promise<void>;

  constructor(options: PostgresAnchorStoreOptions) {
    if (!options.pool && !options.connectionString) throw new Error('PostgresAnchorStore needs a pool or a connectionString');
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
    this.ownsPool = !options.pool;
    this.table = options.table ?? 'audit_chain_anchors';
    if (!/^[a-z_][a-z0-9_]*$/i.test(this.table)) throw new Error(`invalid anchor table name: ${this.table}`);
    this.key = options.hmacKey;
  }

  /** Create the table if it is missing. Called before the first read or write; safe to call again. */
  ensureSchema(): Promise<void> {
    this.schema ??= this.pool
      .query(this.table === 'audit_chain_anchors' ? ANCHOR_TABLE_DDL : ANCHOR_TABLE_DDL.replaceAll('audit_chain_anchors', this.table))
      .then(() => undefined)
      .catch((err: unknown) => {
        this.schema = undefined; // try again next time
        throw err;
      });
    return this.schema;
  }

  async put(claim: ChainAnchorClaim): Promise<ChainAnchor> {
    await this.ensureSchema();
    const anchor = signAnchor(this.key, claim);
    const upserted = await this.pool.query(
      `INSERT INTO ${this.table} (workspace_id, head_hash, count, anchored_at, signature)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE
         SET head_hash = EXCLUDED.head_hash, count = EXCLUDED.count, anchored_at = EXCLUDED.anchored_at,
             signature = EXCLUDED.signature, updated_at = now()
         WHERE ${this.table}.count <= EXCLUDED.count
       RETURNING workspace_id`,
      [anchor.workspaceId, anchor.headHash, anchor.count, anchor.timestamp, anchor.signature]
    );
    if ((upserted.rowCount ?? 0) > 0) return anchor;
    // The stored anchor is longer: it stays, and it is what the caller learns.
    return (await this.get(claim.workspaceId)) ?? anchor;
  }

  async get(workspaceId: string): Promise<ChainAnchor | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT workspace_id, head_hash, count, anchored_at, signature FROM ${this.table} WHERE workspace_id = $1`,
      [workspaceId]
    );
    const row = result.rows[0] as AnchorRow | undefined;
    if (!row) return null;
    const anchor = fromRow(row);
    if (!verifyAnchorSignature(this.key, anchor)) throw new AnchorTamperedError(workspaceId);
    return anchor;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
