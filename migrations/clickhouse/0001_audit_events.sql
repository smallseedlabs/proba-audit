-- Raw, append-only audit trail. One row per StoredAuditEvent (proba-protocol).
-- Never UPDATE or DELETE: the hash chain (prev_hash -> hash) depends on it.
CREATE TABLE IF NOT EXISTS audit_events
(
    event_id          UUID,
    version           UInt8,
    trace_id          UUID,
    span_id           FixedString(16),
    parent_span_id    Nullable(FixedString(16)),
    workspace_id      String,
    user_id           Nullable(UUID),
    goal_id           Nullable(UUID),
    thread_id         Nullable(UUID),
    campaign_id       Nullable(String),
    actor_type        Enum8('user' = 1, 'brain' = 2, 'system' = 3, 'service' = 4),
    actor_id          String,
    service           LowCardinality(String),
    action            LowCardinality(String),
    category          Enum8('command' = 1, 'brain' = 2, 'tool' = 3, 'policy' = 4, 'approval' = 5, 'data_access' = 6, 'memory' = 7, 'metrics' = 8, 'auth' = 9, 'config' = 10, 'system' = 11),
    target_type       Nullable(String),
    target_id         Nullable(String),
    outcome           Enum8('success' = 1, 'failure' = 2, 'denied' = 3, 'partial' = 4),
    error_code        Nullable(String),
    error_message     Nullable(String),
    risk_level        Nullable(Enum8('low' = 1, 'medium' = 2, 'high' = 3)),
    cost_tokens_in    Nullable(UInt64),
    cost_tokens_out   Nullable(UInt64),
    cost_currency     Nullable(FixedString(3)),
    cost_amount       Nullable(Decimal(18, 8)),
    duration_ms       Nullable(Float64),
    occurred_at       DateTime64(3, 'UTC'),
    details           String CODEC(ZSTD(3)),          -- JSON text; no secrets, no raw personal data
    tags              Array(String),
    prev_hash         Nullable(FixedString(64)),      -- NULL for the first event of a chain
    hash              FixedString(64),
    ingested_at       DateTime64(3, 'UTC'),
    schema_version    UInt16,
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_goal_id goal_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_thread_id thread_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (workspace_id, occurred_at, event_id);
