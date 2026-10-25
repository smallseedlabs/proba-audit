-- Daily rollups are cut in the account's reporting timezone: bucket_start is the UTC
-- instant of local midnight (not a UTC midnight for accounts off UTC), timezone says
-- which zone, and bucket_date is the local calendar date (what dashboards group by
-- when accounts in different zones are combined). Rows written before this migration
-- were UTC days: the defaults describe them correctly.
ALTER TABLE metric_rollups_daily ADD COLUMN IF NOT EXISTS timezone String DEFAULT 'UTC';
ALTER TABLE metric_rollups_daily ADD COLUMN IF NOT EXISTS bucket_date Date DEFAULT toDate(bucket_start, 'UTC');
