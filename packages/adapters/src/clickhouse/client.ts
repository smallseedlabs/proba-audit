import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { AppConfig, ClickHouseRole } from '@smallseedlabs/proba-audit-core';

export interface ClickHouseOptions {
  url: string;
  username: string;
  password: string;
  database: string;
}

/**
 * Connection options for a role: the role's own user (CLICKHOUSE_<ROLE>_USER) when set, otherwise the shared
 * CLICKHOUSE_USER. Without a role the shared user is used.
 */
export function clickHouseOptionsFor(config: AppConfig, role?: ClickHouseRole): ClickHouseOptions {
  const { url, database, username, password, roles } = config.clickhouse;
  const credentials = role ? roles[role] : { username, password };
  return { url, database, username: credentials.username, password: credentials.password };
}

/**
 * Settings used by every query so results are easy to map:
 * - ISO timestamps with a Z for DateTime64 columns,
 * - 64-bit integers as JSON numbers (counters stay far below 2^53),
 * - best-effort parsing of ISO strings on insert.
 */
export const COMMON_SETTINGS = {
  date_time_output_format: 'iso',
  output_format_json_quote_64bit_integers: 0,
  date_time_input_format: 'best_effort',
} as const;

export function createClickHouseClient(options: ClickHouseOptions): ClickHouseClient {
  return createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    clickhouse_settings: { ...COMMON_SETTINGS },
  });
}

/** Create the database if it is missing (uses a client without a default database). */
export async function ensureDatabase(options: ClickHouseOptions): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.database)) {
    throw new Error(`Invalid ClickHouse database name: ${options.database}`);
  }
  const admin = createClient({ url: options.url, username: options.username, password: options.password });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${options.database}` });
  } finally {
    await admin.close();
  }
}
