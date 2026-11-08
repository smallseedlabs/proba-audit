-- Maps a Proba campaign id (audit event.campaignId, context-reader scope) to the
-- provider campaign id stored on metric_observations.campaign_id.
-- Additive only: CREATE TABLE IF NOT EXISTS. Does not rebuild or drop existing
-- metric tables, and does not touch shared volumes when applied to a test database.
-- Idempotent: re-running after a half-apply is safe.
CREATE TABLE IF NOT EXISTS metric_campaign_map
(
    workspace_id          String,
    proba_campaign_id     String,
    platform              Enum8('meta' = 1, 'google' = 2, 'reddit' = 3, 'x' = 4, 'microsoft' = 5, 'other' = 6),
    account_id            String,
    provider_campaign_id  String,
    source_event_id       String DEFAULT '',
    source_trace_id       String DEFAULT '',
    updated_at            DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (workspace_id, proba_campaign_id);
