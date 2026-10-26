-- Workspace isolation for the metric tables. Until now a metric row was keyed by ad account only, so two
-- workspaces connecting the same account would have shared (and replaced) each other's rows. Every row now
-- carries workspace_id, and the sorting key leads with it, so a workspace's rows are also stored together.
--
-- ClickHouse cannot put an existing column at the front of a sorting key, so each table is rebuilt:
--   1. create <table>_ws with the new layout,
--   2. copy every row with workspace_id = 'seedbed' (the only workspace the tables could have served; the
--      Hub's single default workspace, and INGEST_WORKSPACE_ID's default). inserted_at and computed_at are
--      copied as they are, so the rollup watermark (changedSince) does not see old rows as new,
--   3. EXCHANGE TABLES (atomic swap), then drop the old data under the temporary name.
-- workspace_id has no DEFAULT on purpose: a writer that forgets it stores '', which no workspace reads,
-- instead of silently attributing rows to 'seedbed'.
--
-- Run it with the apps stopped (writers use the new column from this release on). ClickHouse has no
-- transactions: if it stops between EXCHANGE and DROP, the data is already in place; drop the leftover
-- <table>_ws table by hand and add the row for version 9 to schema_migrations, do not run the file again.
-- Back up first if the old data matters (it is re-fetchable from the ad platforms; audit_events is untouched).
CREATE TABLE IF NOT EXISTS metric_observations_ws
(
    workspace_id    String,
    platform        Enum8('meta' = 1, 'google' = 2, 'reddit' = 3, 'x' = 4, 'microsoft' = 5, 'other' = 6),
    account_id      String,
    campaign_id     String,
    adset_id        String DEFAULT '',
    ad_id           String DEFAULT '',
    granularity     Enum8('hour' = 1, 'day' = 2),
    period_start    DateTime64(3, 'UTC'),
    period_end      DateTime64(3, 'UTC'),
    impressions     UInt64,
    clicks          UInt64,
    spend           Decimal(18, 6),
    conversions     Float64,
    reach           Nullable(UInt64),
    video_views     Nullable(UInt64),
    revenue         Nullable(Decimal(18, 6)),
    currency        FixedString(3),
    timezone        Nullable(String),
    fetched_at      DateTime64(3, 'UTC'),
    revision        UInt32,
    source_ref      Nullable(String),
    inserted_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(period_start)
ORDER BY (workspace_id, platform, account_id, campaign_id, adset_id, ad_id, granularity, period_start);

INSERT INTO metric_observations_ws
    (workspace_id, platform, account_id, campaign_id, adset_id, ad_id, granularity, period_start, period_end, impressions, clicks,
     spend, conversions, reach, video_views, revenue, currency, timezone, fetched_at, revision, source_ref, inserted_at)
SELECT 'seedbed', platform, account_id, campaign_id, adset_id, ad_id, granularity, period_start, period_end, impressions, clicks,
       spend, conversions, reach, video_views, revenue, currency, timezone, fetched_at, revision, source_ref, inserted_at
FROM metric_observations;

EXCHANGE TABLES metric_observations AND metric_observations_ws;

DROP TABLE metric_observations_ws;

CREATE TABLE IF NOT EXISTS metric_rollups_hourly_ws
(
    workspace_id        String,
    platform            Enum8('meta' = 1, 'google' = 2, 'reddit' = 3, 'x' = 4, 'microsoft' = 5, 'other' = 6),
    account_id          String,
    campaign_id         String,
    adset_id            String DEFAULT '',
    ad_id               String DEFAULT '',
    source_granularity  Enum8('hour' = 1, 'day' = 2),
    bucket_start        DateTime64(3, 'UTC'),
    currency            FixedString(3),
    impressions         UInt64,
    clicks              UInt64,
    spend               Decimal(18, 6),
    conversions         Float64,
    video_views         Nullable(UInt64),
    revenue             Nullable(Decimal(18, 6)),
    observation_count   UInt32,
    computed_at         DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (workspace_id, platform, account_id, campaign_id, adset_id, ad_id, source_granularity, currency, bucket_start);

INSERT INTO metric_rollups_hourly_ws
    (workspace_id, platform, account_id, campaign_id, adset_id, ad_id, source_granularity, bucket_start, currency,
     impressions, clicks, spend, conversions, video_views, revenue, observation_count, computed_at)
SELECT 'seedbed', platform, account_id, campaign_id, adset_id, ad_id, source_granularity, bucket_start, currency,
       impressions, clicks, spend, conversions, video_views, revenue, observation_count, computed_at
FROM metric_rollups_hourly;

EXCHANGE TABLES metric_rollups_hourly AND metric_rollups_hourly_ws;

DROP TABLE metric_rollups_hourly_ws;

CREATE TABLE IF NOT EXISTS metric_rollups_daily_ws
(
    workspace_id        String,
    platform            Enum8('meta' = 1, 'google' = 2, 'reddit' = 3, 'x' = 4, 'microsoft' = 5, 'other' = 6),
    account_id          String,
    campaign_id         String,
    adset_id            String DEFAULT '',
    ad_id               String DEFAULT '',
    source_granularity  Enum8('hour' = 1, 'day' = 2),
    bucket_start        DateTime64(3, 'UTC'),
    currency            FixedString(3),
    impressions         UInt64,
    clicks              UInt64,
    spend               Decimal(18, 6),
    conversions         Float64,
    video_views         Nullable(UInt64),
    revenue             Nullable(Decimal(18, 6)),
    observation_count   UInt32,
    computed_at         DateTime64(3, 'UTC'),
    timezone            String DEFAULT 'UTC',
    bucket_date         Date DEFAULT toDate(bucket_start, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (workspace_id, platform, account_id, campaign_id, adset_id, ad_id, source_granularity, currency, bucket_start);

INSERT INTO metric_rollups_daily_ws
    (workspace_id, platform, account_id, campaign_id, adset_id, ad_id, source_granularity, bucket_start, currency,
     impressions, clicks, spend, conversions, video_views, revenue, observation_count, computed_at, timezone, bucket_date)
SELECT 'seedbed', platform, account_id, campaign_id, adset_id, ad_id, source_granularity, bucket_start, currency,
       impressions, clicks, spend, conversions, video_views, revenue, observation_count, computed_at, timezone, bucket_date
FROM metric_rollups_daily;

EXCHANGE TABLES metric_rollups_daily AND metric_rollups_daily_ws;

DROP TABLE metric_rollups_daily_ws;
