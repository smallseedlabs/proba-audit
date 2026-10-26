-- Least-privilege ClickHouse users for proba-audit. Run ONCE per environment as a ClickHouse admin (a user with access management),
-- AFTER `npm run migrate` has created the tables (grants name the tables), and again after a migration that adds a table.
--
--   consumer  audit-consumer, metrics-ingester, rollup: INSERT + SELECT on the audit and metrics tables, nothing else.
--             No UPDATE, no DELETE, no DROP, no TRUNCATE, no DDL. (CheckpointStore.delete, used only by tests and tools that reset a cursor,
--             needs ALTER DELETE and ALTER UPDATE on ingest_checkpoints: run those as the migrator or an admin.)
--   api       audit-api and the metrics report: SELECT only.
--   migrator  `npm run migrate`: DDL on the database (and creating it). Used for nothing else.
--
-- Replace the placeholders (and the database name if CLICKHOUSE_DATABASE is not proba_audit) before running, for example:
--   sed -e "s/__CONSUMER_PASSWORD__/$CONSUMER_PW/" -e "s/__API_PASSWORD__/$API_PW/" -e "s/__MIGRATOR_PASSWORD__/$MIGRATOR_PW/" \
--       scripts/clickhouse-roles.sql | clickhouse-client --multiquery
-- Then set CLICKHOUSE_CONSUMER_USER/PASSWORD, CLICKHOUSE_API_USER/PASSWORD and CLICKHOUSE_MIGRATOR_USER/PASSWORD (see .env.example).
-- Without them every process keeps using CLICKHOUSE_USER/PASSWORD, which is what the local docker stack does.
-- Never commit real passwords.

CREATE USER IF NOT EXISTS proba_consumer IDENTIFIED WITH sha256_password BY '__CONSUMER_PASSWORD__';
CREATE USER IF NOT EXISTS proba_api      IDENTIFIED WITH sha256_password BY '__API_PASSWORD__';
CREATE USER IF NOT EXISTS proba_migrator IDENTIFIED WITH sha256_password BY '__MIGRATOR_PASSWORD__';

-- migrator: schema changes, including `CREATE DATABASE IF NOT EXISTS` and the schema_migrations bookkeeping table.
GRANT CREATE DATABASE ON proba_audit.* TO proba_migrator;
GRANT ALL ON proba_audit.* TO proba_migrator;

-- consumer: write and read back (duplicate detection, chain heads, FINAL reads, INSERT ... SELECT for rollups).
GRANT INSERT, SELECT ON proba_audit.audit_events                  TO proba_consumer;
GRANT INSERT, SELECT ON proba_audit.audit_event_content           TO proba_consumer;
GRANT INSERT, SELECT ON proba_audit.metric_observations           TO proba_consumer;
GRANT INSERT, SELECT ON proba_audit.metric_rollups_hourly         TO proba_consumer;
GRANT INSERT, SELECT ON proba_audit.metric_rollups_daily          TO proba_consumer;
GRANT INSERT, SELECT ON proba_audit.ingest_checkpoints            TO proba_consumer;
GRANT INSERT, SELECT ON proba_audit.metric_observation_quarantine TO proba_consumer;

-- api: read only.
GRANT SELECT ON proba_audit.audit_events                  TO proba_api;
GRANT SELECT ON proba_audit.audit_event_content           TO proba_api;
GRANT SELECT ON proba_audit.metric_observations           TO proba_api;
GRANT SELECT ON proba_audit.metric_rollups_hourly         TO proba_api;
GRANT SELECT ON proba_audit.metric_rollups_daily          TO proba_api;
GRANT SELECT ON proba_audit.ingest_checkpoints            TO proba_api;
GRANT SELECT ON proba_audit.metric_observation_quarantine TO proba_api;
