import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAuditEvent } from '@smallseedlabs/proba-protocol/audit';
import { runOutboxStoreContract } from '@smallseedlabs/proba-audit-core/testing';
import { PostgresOutboxStore } from './outbox-store.js';

const url = process.env.OUTBOX_TEST_DATABASE_URL ?? 'postgresql://proba:proba@localhost:5432/proba_audit_outbox_test';
const pool = new pg.Pool({ connectionString: url });
afterAll(() => pool.end());

const tables: string[] = [];
async function freshStore(): Promise<{ store: PostgresOutboxStore; table: string }> {
  const table = `audit_outbox_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const store = new PostgresOutboxStore({ pool, table });
  await store.ensureSchema();
  tables.push(table);
  return { store, table };
}
afterAll(async () => {
  for (const t of tables) await pool.query(`DROP TABLE IF EXISTS ${t}`);
});

// Each test gets its own table, so the contract's "starts empty" holds. The store
// shares one pool, which the store never closes (it does not own it).
runOutboxStoreContract('postgres', async () => ({ store: (await freshStore()).store }));

const event = () =>
  buildAuditEvent({
    traceId: randomUUID(),
    workspaceId: 'seedbed',
    actor: { type: 'service', id: 'hub' },
    service: 'hub',
    action: 'command.received',
    category: 'command',
    outcome: 'success',
  });

describe('PostgresOutboxStore specifics', () => {
  it('writes in the caller transaction: invisible before COMMIT, gone after ROLLBACK', async () => {
    const { store } = await freshStore();
    const committed = pool.connect();
    const client = await committed;
    await client.query('BEGIN');
    await store.enqueue([event()], client);
    expect(await store.pendingCount()).toBe(0); // other connections cannot see it yet
    await client.query('COMMIT');
    client.release();
    expect(await store.pendingCount()).toBe(1);

    const rolledBack = await pool.connect();
    await rolledBack.query('BEGIN');
    await store.enqueue([event(), event()], rolledBack);
    await rolledBack.query('ROLLBACK');
    rolledBack.release();
    expect(await store.pendingCount()).toBe(1);
  });

  it('lets concurrent relays claim disjoint rows (FOR UPDATE SKIP LOCKED)', async () => {
    const { store, table } = await freshStore();
    await store.enqueue(Array.from({ length: 40 }, event));
    const other = new PostgresOutboxStore({ pool, table });
    const [a, b] = await Promise.all([store.claim(25, 30_000), other.claim(25, 30_000)]);
    const ids = [...a, ...b].map((c) => c.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('is idempotent about the schema and rejects unsafe table names', async () => {
    const { store } = await freshStore();
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    expect(() => new PostgresOutboxStore({ pool, table: 'x; DROP TABLE y' })).toThrow(/invalid outbox table/);
    expect(() => new PostgresOutboxStore({})).toThrow(/pool or a connectionString/);
  });
});
