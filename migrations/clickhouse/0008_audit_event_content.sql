-- Raw text of audit events (protocol 0.3.3 AuditEvent.content), kept APART from audit_events so it can
-- have its own retention and its own permissions:
--   * audit_events only holds `content_digest` (SHA-256 of the canonical text). The hash chain covers it,
--     so changing or swapping the text is detectable, and deleting the text (retention) leaves the chain valid.
--   * audit_event_content holds the text. Grant it to fewer users than audit_events; the read API serves it to admins only.
-- Retention (not set here, decide per deployment): for example
--   ALTER TABLE audit_event_content MODIFY TTL toDateTime(occurred_at) + INTERVAL 6 MONTH;
-- or drop whole months:  ALTER TABLE audit_event_content DROP PARTITION 202610;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS content_digest Nullable(FixedString(64));

CREATE TABLE IF NOT EXISTS audit_event_content
(
    workspace_id    String,
    event_id        UUID,
    occurred_at     DateTime64(3, 'UTC'),             -- the event's occurred_at: partitions by month
    kind            LowCardinality(String),
    text            String CODEC(ZSTD(3)),            -- secrets already masked by the producer
    truncated       UInt8,
    original_length UInt32,
    redactions      UInt32,
    content_digest  FixedString(64),                  -- equals audit_events.content_digest of the same event
    stored_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(stored_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (workspace_id, event_id);
