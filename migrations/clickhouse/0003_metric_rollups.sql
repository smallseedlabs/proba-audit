-- Rollups are computed by the rollup process from the latest observation
-- revisions and rewritten idempotently (ReplacingMergeTree on computed_at), so a
-- restated observation never double counts. Buckets are UTC.
-- `reach` is not rolled up: unique reach is not additive.
CREATE TABLE IF NOT EXISTS metric_rollups_hourly
(
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
ORDER BY (platform, account_id, campaign_id, adset_id, ad_id, source_granularity, currency, bucket_start);

CREATE TABLE IF NOT EXISTS metric_rollups_daily
(
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
ORDER BY (platform, account_id, campaign_id, adset_id, ad_id, source_granularity, currency, bucket_start);
