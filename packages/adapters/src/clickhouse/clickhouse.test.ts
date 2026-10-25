import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeObservation, makeStoredAuditEvent } from '@smallseedlabs/proba-audit-core/testing';
import { buildAggregateSql, buildAuditWhere, fromRow, toRow } from './audit-store.js';
import { fromObservationRow, toObservationRow } from './metrics-store.js';
import {
  loadMigrations,
  runMigrations,
  splitStatements,
  type AppliedMigration,
  type MigrationDb,
} from './migrate.js';

const migrationsDir = resolve(__dirname, '../../../../migrations/clickhouse');

function fakeDb(applied: AppliedMigration[] = []) {
  const commands: string[] = [];
  const recorded: AppliedMigration[] = [];
  const db: MigrationDb = {
    async command(sql) {
      commands.push(sql);
    },
    async listApplied() {
      return applied;
    },
    async recordApplied(m) {
      recorded.push(m);
    },
  };
  return { db, commands, recorded };
}

describe('row mapping', () => {
  it('round-trips a full audit event', () => {
    const e = makeStoredAuditEvent({
      userId: '770e8400-e29b-41d4-a716-446655440000',
      campaignId: 'c1',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      target: { type: 'goal', id: 'g' },
      errorCode: 'E',
      errorMessage: 'm',
      riskLevel: 'low',
      cost: { tokensIn: 1, tokensOut: 2, currency: 'USD', amount: 0.5 },
      durationMs: 12,
      tags: ['a'],
      details: { n: { x: 1 } },
    });
    expect(fromRow(toRow(e))).toEqual(e);
  });

  it('maps absent optionals to null and back to absent', () => {
    const e = makeStoredAuditEvent();
    const row = toRow(e);
    expect(row.user_id).toBeNull();
    expect(row.cost_amount).toBeNull();
    expect(row.tags).toEqual([]);
    expect(fromRow(row)).toEqual(e);
  });

  it('round-trips observations; campaign level rows use empty adset/ad ids', () => {
    const campaignLevel = makeObservation();
    expect(toObservationRow(campaignLevel)).toMatchObject({ adset_id: '', ad_id: '', reach: null, timezone: null });
    expect(fromObservationRow(toObservationRow(campaignLevel))).toEqual(campaignLevel);
    const full = makeObservation({ adsetId: 'as', adId: 'ad', timezone: 'Europe/London', sourceRef: 's', metrics: { impressions: 1, clicks: 1, spend: 1, conversions: 1, reach: 1, videoViews: 1, revenue: 1 } });
    expect(fromObservationRow(toObservationRow(full))).toEqual(full);
  });
});

describe('SQL building', () => {
  it('binds every filter value as a parameter (no interpolation)', () => {
    const w = buildAuditWhere({ workspaceId: "w'; DROP TABLE audit_events; --", category: 'brain', from: '2026-10-25T00:00:00.000Z' });
    expect(w.sql).not.toContain('DROP');
    expect(w.sql).toContain('workspace_id = {workspaceId:String}');
    expect(w.sql).toContain('category = {category:String}');
    expect(w.sql).toContain('occurred_at >=');
    expect(w.params.workspaceId).toContain('DROP');
  });

  it('builds no WHERE for an empty filter', () => {
    expect(buildAuditWhere({}).sql).toBe('');
  });

  it('groups aggregates by the requested keys only', () => {
    const q = buildAggregateSql({ filter: { workspaceId: 'w' }, groupBy: ['category', 'hour'] });
    expect(q.sql).toContain('GROUP BY k0, k1');
    expect(buildAggregateSql({ filter: {}, groupBy: [] }).sql).not.toContain('GROUP BY');
  });
});

describe('migration runner', () => {
  it('splits statements and drops comment lines', () => {
    expect(splitStatements('-- c\nCREATE TABLE a (x Int8);\n\n-- d\nCREATE TABLE b (y Int8);\n')).toEqual([
      'CREATE TABLE a (x Int8)',
      'CREATE TABLE b (y Int8)',
    ]);
  });

  it('loads the real migrations in order with checksums', () => {
    const m = loadMigrations(migrationsDir);
    expect(m.map((x) => x.filename)).toEqual([
      '0001_audit_events.sql',
      '0002_metric_observations.sql',
      '0003_metric_rollups.sql',
      '0004_audit_events_durability.sql',
    ]);
    expect(m.map((x) => x.statements.length)).toEqual([1, 1, 2, 1]);
    expect(new Set(m.map((x) => x.checksum)).size).toBe(4);
  });

  it('keeps every statement idempotent', () => {
    for (const m of loadMigrations(migrationsDir)) {
      for (const s of m.statements) expect(s).toMatch(/^(CREATE (TABLE|DATABASE) IF NOT EXISTS|ALTER TABLE \w+ MODIFY SETTING)/);
    }
  });

  it('applies pending migrations in order and records them', async () => {
    const { db, commands, recorded } = fakeDb();
    const result = await runMigrations(db, loadMigrations(migrationsDir));
    expect(result.applied).toHaveLength(4);
    expect(commands).toHaveLength(5);
    expect(recorded.map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it('skips applied migrations and only runs new ones', async () => {
    const all = loadMigrations(migrationsDir);
    const { db, commands, recorded } = fakeDb([{ version: 1, name: all[0].name, checksum: all[0].checksum }]);
    const result = await runMigrations(db, all);
    expect(result.skipped).toEqual(['0001_audit_events.sql']);
    expect(result.applied).toEqual([
      '0002_metric_observations.sql',
      '0003_metric_rollups.sql',
      '0004_audit_events_durability.sql',
    ]);
    expect(commands).toHaveLength(4);
    expect(recorded.map((r) => r.version)).toEqual([2, 3, 4]);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const all = loadMigrations(migrationsDir);
    const { db, commands } = fakeDb([{ version: 1, name: all[0].name, checksum: 'different' }]);
    await expect(runMigrations(db, all)).rejects.toThrow(/contents changed/);
    expect(commands).toHaveLength(0);
  });

  it('rejects badly named or non-sequential files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0002_skip.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/sequential/);
    const bad = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(bad, 'create.sql'), 'SELECT 1;');
    expect(() => loadMigrations(bad)).toThrow(/Invalid migration filename/);
  });
});
