import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ANCHOR_TABLE_DDL } from './anchor-store.js';

const statement = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim();

describe('PostgresAnchorStore schema', () => {
  it('the DDL the adapter runs equals migrations/postgres/0002_audit_chain_anchors.sql', () => {
    const migration = readFileSync(fileURLToPath(new URL('../../../../migrations/postgres/0002_audit_chain_anchors.sql', import.meta.url)), 'utf8');
    expect(statement(ANCHOR_TABLE_DDL)).toBe(statement(migration));
  });
});
