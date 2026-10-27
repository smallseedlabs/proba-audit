import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@smallseedlabs/proba-audit-core';
import { RoleProvisioningError, createRoleUsers, grantTableAccess, planRoleProvisioning } from './roles.js';

const prod = {
  NODE_ENV: 'production',
  CLICKHOUSE_USER: 'proba',
  CLICKHOUSE_PASSWORD: 'admin-pw',
  CLICKHOUSE_DATABASE: 'proba_audit',
  CLICKHOUSE_CONSUMER_PASSWORD: 'consumer-pw',
  CLICKHOUSE_API_PASSWORD: 'api-pw',
  CLICKHOUSE_MIGRATOR_PASSWORD: 'migrator-pw',
};

function fakeAdmin(tables: string[] = ['audit_events', 'audit_event_content', 'schema_migrations']) {
  const commands: string[] = [];
  const client = {
    async command({ query }: { query: string }) {
      commands.push(query);
    },
    async query() {
      return { json: async () => tables.map((name) => ({ name })) };
    },
  } as unknown as ClickHouseClient;
  return { client, commands };
}

describe('planRoleProvisioning', () => {
  it('production: creates the three default users from the three required passwords', () => {
    const plan = planRoleProvisioning(loadConfig(prod));
    expect(plan.database).toBe('proba_audit');
    expect(plan.roles).toEqual({
      consumer: { username: 'proba_consumer', password: 'consumer-pw' },
      api: { username: 'proba_api', password: 'api-pw' },
      migrator: { username: 'proba_migrator', password: 'migrator-pw' },
    });
    expect(plan.skipped).toEqual([]);
  });

  it.each(['CONSUMER', 'API', 'MIGRATOR'])('production: a missing CLICKHOUSE_%s_PASSWORD stops the migrator', (role) => {
    const env = { ...prod, [`CLICKHOUSE_${role}_PASSWORD`]: '' };
    expect(() => planRoleProvisioning(loadConfig(env))).toThrow(new RegExp(`CLICKHOUSE_${role}_PASSWORD is required in production`));
  });

  it('production: a role user equal to the admin user is refused (it would rewrite the admin password)', () => {
    const config = loadConfig({ ...prod, CLICKHOUSE_API_USER: 'proba' });
    expect(() => planRoleProvisioning(config)).toThrow(RoleProvisioningError);
    expect(() => planRoleProvisioning(config)).toThrow(/admin user CLICKHOUSE_USER/);
  });

  it('refuses two roles sharing one user', () => {
    const config = loadConfig({ ...prod, CLICKHOUSE_API_USER: 'proba_consumer' });
    expect(() => planRoleProvisioning(config)).toThrow(/three different users/);
  });

  it('refuses unsafe user names and passwords with control characters', () => {
    expect(() => planRoleProvisioning(loadConfig({ ...prod, CLICKHOUSE_API_USER: 'x; DROP USER y' }))).toThrow(/not a plain identifier/);
    expect(() => planRoleProvisioning(loadConfig({ ...prod, CLICKHOUSE_API_PASSWORD: 'a\nb' }))).toThrow(/control characters/);
  });

  it('outside production: only roles with a user and password of their own are created, the rest keep the shared user', () => {
    const plan = planRoleProvisioning(
      loadConfig({ CLICKHOUSE_USER: 'proba', CLICKHOUSE_PASSWORD: 'pw', CLICKHOUSE_API_USER: 'proba_api', CLICKHOUSE_API_PASSWORD: 'api-pw' })
    );
    expect(Object.keys(plan.roles)).toEqual(['api']);
    expect(plan.skipped).toEqual(['consumer', 'migrator']);
  });
});

describe('createRoleUsers / grantTableAccess', () => {
  const plan = planRoleProvisioning(loadConfig(prod));

  it('creates the users, sets their password (rotation) and gives the migrator its database rights', async () => {
    const { client, commands } = fakeAdmin();
    expect(await createRoleUsers(client, plan)).toEqual(['proba_consumer', 'proba_api', 'proba_migrator']);
    expect(commands).toContain("CREATE USER IF NOT EXISTS proba_consumer IDENTIFIED WITH sha256_password BY 'consumer-pw'");
    expect(commands).toContain("ALTER USER proba_api IDENTIFIED WITH sha256_password BY 'api-pw'");
    expect(commands).toContain('GRANT ALL ON proba_audit.* TO proba_migrator');
  });

  it('escapes quotes and backslashes in a password', async () => {
    const { client, commands } = fakeAdmin();
    const odd = planRoleProvisioning(loadConfig({ ...prod, CLICKHOUSE_API_PASSWORD: "p'a\\ss" }));
    await createRoleUsers(client, odd);
    expect(commands).toContain("CREATE USER IF NOT EXISTS proba_api IDENTIFIED WITH sha256_password BY 'p\\'a\\\\ss'");
  });

  it('grants INSERT+SELECT to the consumer and SELECT to the api on every data table, and never ALTER or DELETE', async () => {
    const { client, commands } = fakeAdmin();
    expect(await grantTableAccess(client, plan)).toEqual(['audit_events', 'audit_event_content']);
    expect(commands).toEqual([
      'GRANT INSERT, SELECT ON proba_audit.audit_events TO proba_consumer',
      'GRANT SELECT ON proba_audit.audit_events TO proba_api',
      'GRANT INSERT, SELECT ON proba_audit.audit_event_content TO proba_consumer',
      'GRANT SELECT ON proba_audit.audit_event_content TO proba_api',
    ]);
    expect(commands.join('\n')).not.toMatch(/ALTER|DELETE|UPDATE|DROP|TRUNCATE|ALL ON/i);
  });

  it('never grants anything on the migration bookkeeping table', async () => {
    const { client, commands } = fakeAdmin();
    await grantTableAccess(client, plan);
    expect(commands.join('\n')).not.toContain('schema_migrations');
  });

  it('the manual script scripts/clickhouse-roles.sql grants the same privileges (INSERT+SELECT / SELECT, no ALTER)', () => {
    const sql = readFileSync(resolve(__dirname, '../../../../scripts/clickhouse-roles.sql'), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/GRANT[^;]*(ALTER|DELETE|UPDATE|DROP|TRUNCATE)[^;]*TO proba_(consumer|api)/);
    expect(sql).toMatch(/GRANT INSERT, SELECT ON proba_audit\.audit_events\s+TO proba_consumer/);
    expect(sql).toMatch(/GRANT SELECT ON proba_audit\.audit_events\s+TO proba_api/);
  });
});
