/**
 * Minimal versioned SQL migration runner for ClickHouse.
 *
 * - Files live in a directory and are named NNNN_description.sql (NNNN = version).
 * - Applied versions are recorded in the `schema_migrations` table with a checksum.
 * - A file that was already applied but has since changed is an error: add a new
 *   migration instead of editing an old one.
 * - A file may hold several statements separated by `;` at the end of a line. Do
 *   not put a `;` at the end of a line inside a string literal or a comment.
 * - ClickHouse has no transactions: write statements idempotently (IF NOT EXISTS)
 *   so a half-applied file can simply be re-run.
 * - Run one migrator at a time; there is no lock.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  checksum: string;
  statements: string[];
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

/** The small part of a ClickHouse client the runner needs (easy to fake in tests). */
export interface MigrationDb {
  command(sql: string): Promise<void>;
  listApplied(): Promise<AppliedMigration[]>;
  recordApplied(m: { version: number; name: string; checksum: string }): Promise<void>;
}

export interface MigrationLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Split SQL into statements: `;` at the end of a line, `--` comment-only lines dropped. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0);
}

export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrations = files.map((filename) => {
    const match = FILENAME.exec(filename);
    if (!match) throw new Error(`Invalid migration filename "${filename}" (expected NNNN_description.sql)`);
    const sql = readFileSync(join(dir, filename), 'utf8');
    return {
      version: Number(match[1]),
      name: match[2],
      filename,
      checksum: createHash('sha256').update(sql).digest('hex'),
      statements: splitStatements(sql),
    };
  });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration versions must be sequential from 0001: found ${m.filename} at position ${i + 1}`);
    }
  });
  return migrations;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  db: MigrationDb,
  migrations: MigrationFile[],
  logger?: MigrationLogger
): Promise<MigrationResult> {
  const applied = new Map((await db.listApplied()).map((m) => [m.version, m]));
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const m of migrations) {
    const done = applied.get(m.version);
    if (done) {
      if (done.checksum !== m.checksum) {
        throw new Error(
          `Migration ${m.filename} was already applied but its contents changed. Add a new migration instead of editing it.`
        );
      }
      result.skipped.push(m.filename);
      continue;
    }
    logger?.info('applying migration', { migration: m.filename, statements: m.statements.length });
    for (const statement of m.statements) await db.command(statement);
    await db.recordApplied({ version: m.version, name: m.name, checksum: m.checksum });
    result.applied.push(m.filename);
  }
  return result;
}

export const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations
(
    version     UInt32,
    name        String,
    checksum    String,
    applied_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY version`;
