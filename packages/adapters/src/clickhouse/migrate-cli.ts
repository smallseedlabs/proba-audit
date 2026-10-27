/**
 * `npm run migrate`: create the database if needed, create the append-only ClickHouse users (consumer: INSERT + SELECT,
 * api: SELECT, migrator: DDL), apply pending ClickHouse migrations, then grant the users access to the tables.
 * Connection settings come from the same env vars as the apps. The admin (CLICKHOUSE_USER / CLICKHOUSE_PASSWORD) is used
 * for the user and grant statements only; the migrations run as the migrator user when it has one. In production the three
 * role passwords (CLICKHOUSE_CONSUMER_PASSWORD, CLICKHOUSE_API_PASSWORD, CLICKHOUSE_MIGRATOR_PASSWORD) are required.
 */

import { isAbsolute, resolve } from 'node:path';
import { createLogger, loadConfigFromEnvironment } from '@smallseedlabs/proba-audit-core';
import { clickHouseOptionsFor, createClickHouseClient, ensureDatabase } from './client.js';
import { createRoleUsers, grantTableAccess, planRoleProvisioning } from './roles.js';
import { clickHouseMigrationDb } from './migrate-db.js';
import { loadMigrations, runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const config = loadConfigFromEnvironment({ serviceName: 'proba-audit-migrate' });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env });
  const dir = isAbsolute(config.clickhouse.migrationsDir)
    ? config.clickhouse.migrationsDir
    : resolve(process.cwd(), config.clickhouse.migrationsDir);

  // Decide first (and fail first) which users to create: in production a missing password stops the run before anything changes.
  const plan = planRoleProvisioning(config);
  const admin = clickHouseOptionsFor(config);
  logger.info('migration starting', { lifecycle: 'starting', database: admin.database, admin: admin.username, dir, roles: Object.keys(plan.roles), rolesSkipped: plan.skipped });
  await ensureDatabase(admin);

  const adminClient = createClickHouseClient(admin);
  try {
    const users = await createRoleUsers(adminClient, plan);
    if (users.length > 0) logger.info('clickhouse users ready', { lifecycle: 'roles_created', users });

    // The migrations run as the migrator user (CLICKHOUSE_MIGRATOR_USER, in production proba_migrator), falling back to the admin.
    const options = clickHouseOptionsFor(config, 'migrator');
    const client = createClickHouseClient(options);
    try {
      const result = await runMigrations(clickHouseMigrationDb(client), loadMigrations(dir), logger);
      logger.info('migration finished', { lifecycle: 'finished', user: options.username, ...result });
    } finally {
      await client.close();
    }

    const tables = await grantTableAccess(adminClient, plan);
    if (users.length > 0) logger.info('clickhouse table grants applied', { lifecycle: 'roles_granted', tables });
  } finally {
    await adminClient.close();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
