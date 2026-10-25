/**
 * `npm run migrate`: create the database if needed and apply pending ClickHouse
 * migrations. Connection settings come from the same env vars as the apps.
 */

import { isAbsolute, resolve } from 'node:path';
import { createLogger, loadConfigFromEnvironment } from '@smallseedlabs/proba-audit-core';
import { createClickHouseClient, ensureDatabase } from './client.js';
import { clickHouseMigrationDb } from './migrate-db.js';
import { loadMigrations, runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const config = loadConfigFromEnvironment({ serviceName: 'proba-audit-migrate' });
  const logger = createLogger({ service: config.service.name, level: config.log.level, env: config.env });
  const dir = isAbsolute(config.clickhouse.migrationsDir)
    ? config.clickhouse.migrationsDir
    : resolve(process.cwd(), config.clickhouse.migrationsDir);

  logger.info('migration starting', { lifecycle: 'starting', database: config.clickhouse.database, dir });
  await ensureDatabase(config.clickhouse);
  const client = createClickHouseClient(config.clickhouse);
  try {
    const result = await runMigrations(clickHouseMigrationDb(client), loadMigrations(dir), logger);
    logger.info('migration finished', { lifecycle: 'finished', ...result });
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
