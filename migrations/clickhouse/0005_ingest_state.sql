-- State of the metrics ingestion pipeline.
--
-- ingest_checkpoints: how far each (workspace, source, account, stream) got. Written
-- only after the data it describes is durable; ReplacingMergeTree(updated_at) keeps the
-- latest row per key (always read with FINAL). `source` is a platform id for connector
-- cursors, or 'rollup' for the rollup process watermark.
CREATE TABLE IF NOT EXISTS ingest_checkpoints
(
    workspace_id  String,
    source        String,
    account_id    String,
    stream        String,
    cursor        String,
    run_id        String,
    updated_at    DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (workspace_id, source, account_id, stream);

-- metric_observation_quarantine: observations that failed validation. They never reach
-- metric_observations. Kept 90 days with the reason so they can be inspected and re-pulled.
CREATE TABLE IF NOT EXISTS metric_observation_quarantine
(
    quarantine_id  String,
    workspace_id   String,
    platform       String,
    account_id     String,
    run_id         String,
    reason         String,
    issues         String,                -- JSON array of { path, message }; no values
    payload        String,                -- raw JSON as received
    quarantined_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(quarantined_at)
ORDER BY (workspace_id, platform, account_id, quarantined_at, quarantine_id)
TTL toDateTime(quarantined_at) + INTERVAL 90 DAY;
