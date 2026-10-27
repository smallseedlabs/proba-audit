import type { ClickHouseClient } from '@clickhouse/client';
import type { AppConfig, ClickHouseCredentials, ClickHouseRole } from '@smallseedlabs/proba-audit-core';

/**
 * Append-only ClickHouse users, created by `npm run migrate` (not by hand):
 *
 *   consumer  INSERT + SELECT on every data table. No UPDATE, DELETE, DROP, TRUNCATE or DDL: whoever steals the consumer
 *             credentials can add events but cannot rewrite or erase the audit trail.
 *   api       SELECT only.
 *   migrator  ALL on the database (DDL), and nothing global. Used by `npm run migrate` for the migrations only.
 *
 * Creating users needs access management, so the migrate command connects as the admin (CLICKHOUSE_USER) for this step and
 * for nothing the services run. scripts/clickhouse-roles.sql is the same set of statements for an operator who prefers to run them by hand.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Tables the services must never be able to touch: the migration bookkeeping. */
const RESERVED_TABLES = new Set(['schema_migrations']);

export class RoleProvisioningError extends Error {
  constructor(readonly problems: string[]) {
    super(`Cannot create the ClickHouse users:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'RoleProvisioningError';
  }
}

export interface RoleProvisioningPlan {
  database: string;
  /** The roles to create, with the user name and password each one gets. */
  roles: Partial<Record<ClickHouseRole, ClickHouseCredentials>>;
  /** Roles left alone (outside production, a role without a password of its own keeps using the shared CLICKHOUSE_USER). */
  skipped: ClickHouseRole[];
}

const ROLES: ClickHouseRole[] = ['consumer', 'api', 'migrator'];

/**
 * What the migrator creates, from the config.
 * - Production: all three users, so all three passwords are REQUIRED (CLICKHOUSE_CONSUMER_PASSWORD, CLICKHOUSE_API_PASSWORD,
 *   CLICKHOUSE_MIGRATOR_PASSWORD).
 * - Elsewhere: each role that has a password of its own; the others keep using CLICKHOUSE_USER, so a local stack needs no setup.
 * A role user is never the admin user (that would rewrite the admin's password), and the three are distinct.
 */
export function planRoleProvisioning(config: AppConfig): RoleProvisioningPlan {
  const problems: string[] = [];
  const roles: RoleProvisioningPlan['roles'] = {};
  const skipped: ClickHouseRole[] = [];
  if (!IDENTIFIER.test(config.clickhouse.database)) problems.push(`CLICKHOUSE_DATABASE "${config.clickhouse.database}" is not a plain identifier`);

  for (const role of ROLES) {
    const creds = config.clickhouse.roles[role];
    const label = `CLICKHOUSE_${role.toUpperCase()}`;
    if (creds.username === config.clickhouse.username) {
      // Not provisioned: the role falls back to the admin user (only possible outside production).
      if (config.isProduction) problems.push(`${label}_USER "${creds.username}" is the admin user CLICKHOUSE_USER; give the role its own user`);
      else skipped.push(role);
      continue;
    }
    if (creds.password === '') {
      if (config.isProduction) problems.push(`${label}_PASSWORD is required in production (it protects the "${creds.username}" user)`);
      else skipped.push(role);
      continue;
    }
    if (!IDENTIFIER.test(creds.username)) {
      problems.push(`${label}_USER "${creds.username}" is not a plain identifier (letters, digits, underscore)`);
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(creds.password)) {
      problems.push(`${label}_PASSWORD contains control characters`);
      continue;
    }
    roles[role] = creds;
  }
  const names = Object.values(roles).map((c) => c.username);
  if (new Set(names).size !== names.length) problems.push('the consumer, api and migrator users must be three different users');
  if (problems.length > 0) throw new RoleProvisioningError(problems);
  return { database: config.clickhouse.database, roles, skipped };
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Step 1, before the migrations: create the users (or set their password again, so a rotated password takes effect) and give the
 * migrator its database rights. Idempotent. Run as the admin.
 */
export async function createRoleUsers(admin: ClickHouseClient, plan: RoleProvisioningPlan): Promise<string[]> {
  const created: string[] = [];
  for (const role of ROLES) {
    const creds = plan.roles[role];
    if (!creds) continue;
    await admin.command({ query: `CREATE USER IF NOT EXISTS ${creds.username} IDENTIFIED WITH sha256_password BY ${literal(creds.password)}` });
    await admin.command({ query: `ALTER USER ${creds.username} IDENTIFIED WITH sha256_password BY ${literal(creds.password)}` });
    created.push(creds.username);
  }
  const migrator = plan.roles.migrator;
  if (migrator) {
    await admin.command({ query: `GRANT CREATE DATABASE ON ${plan.database}.* TO ${migrator.username}` });
    await admin.command({ query: `GRANT ALL ON ${plan.database}.* TO ${migrator.username}` });
  }
  return created;
}

/** The tables of the database a service may use: everything the migrations created except their own bookkeeping. */
export async function listDataTables(admin: ClickHouseClient, database: string): Promise<string[]> {
  const rs = await admin.query({
    query: 'SELECT name FROM system.tables WHERE database = {database:String} ORDER BY name',
    query_params: { database },
    format: 'JSONEachRow',
  });
  return ((await rs.json()) as { name: string }[]).map((r) => r.name).filter((name) => !RESERVED_TABLES.has(name) && IDENTIFIER.test(name));
}

/**
 * Step 2, after the migrations (so new tables are covered): consumer INSERT + SELECT, api SELECT, table by table.
 * No ALTER, DELETE, DROP or TRUNCATE is ever granted. Idempotent. Run as the admin.
 */
export async function grantTableAccess(admin: ClickHouseClient, plan: RoleProvisioningPlan): Promise<string[]> {
  const tables = await listDataTables(admin, plan.database);
  for (const table of tables) {
    if (plan.roles.consumer) await admin.command({ query: `GRANT INSERT, SELECT ON ${plan.database}.${table} TO ${plan.roles.consumer.username}` });
    if (plan.roles.api) await admin.command({ query: `GRANT SELECT ON ${plan.database}.${table} TO ${plan.roles.api.username}` });
  }
  return tables;
}
