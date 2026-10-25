-- Normalised ad-platform observations (MetricObservation in proba-protocol).
-- ReplacingMergeTree(revision) keeps the highest revision per sorting key once
-- parts merge, so always read with FINAL (the adapters do).
-- adset_id / ad_id are '' for campaign-level rows (sorting keys cannot be NULL),
-- and are part of the key so campaign, adset and ad rows never replace each other.
CREATE TABLE IF NOT EXISTS metric_observations
(
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
    timezone        Nullable(String),                  -- ad account reporting timezone (IANA)
    fetched_at      DateTime64(3, 'UTC'),
    revision        UInt32,
    source_ref      Nullable(String),
    inserted_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(period_start)
ORDER BY (platform, account_id, campaign_id, adset_id, ad_id, granularity, period_start);
