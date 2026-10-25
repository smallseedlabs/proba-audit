import type { ClickHouseClient } from '@clickhouse/client';
import { MIGRATIONS_TABLE_DDL, type AppliedMigration, type MigrationDb } from './migrate.js';

/** MigrationDb backed by a real ClickHouse client (database already selected). */
export function clickHouseMigrationDb(client: ClickHouseClient): MigrationDb {
  return {
    async command(sql) {
      await client.command({ query: sql });
    },
    async listApplied() {
      await client.command({ query: MIGRATIONS_TABLE_DDL });
      const rs = await client.query({
        query: 'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
        format: 'JSONEachRow',
      });
      return (await rs.json()) as AppliedMigration[];
    },
    async recordApplied(m) {
      await client.insert({ table: 'schema_migrations', values: [m], format: 'JSONEachRow' });
    },
  };
}
