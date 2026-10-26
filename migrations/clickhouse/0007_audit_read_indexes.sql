-- Read API (apps/audit-api) support. The sorting key is (workspace_id, occurred_at, event_id), which
-- serves time-ordered pages of one workspace. These skip indexes serve the lookups it cannot:
--   event_id     GET /v1/events/:eventId
--   campaign_id  the campaign filter and the campaign facet
--   action       the action filter and the action facet
--   ingested_at  chain verification ranges (the chain is ordered by ingested_at, not occurred_at)
-- trace_id, goal_id and thread_id already have bloom filter indexes (0001).
-- Indexes only describe data, they never change it; the audit trail stays append-only.
ALTER TABLE audit_events ADD INDEX IF NOT EXISTS idx_event_id event_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE audit_events ADD INDEX IF NOT EXISTS idx_campaign_id campaign_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE audit_events ADD INDEX IF NOT EXISTS idx_action action TYPE set(1000) GRANULARITY 4;
ALTER TABLE audit_events ADD INDEX IF NOT EXISTS idx_ingested_at ingested_at TYPE minmax GRANULARITY 1;
-- New indexes only cover parts written from now on: build them for the existing parts too.
ALTER TABLE audit_events MATERIALIZE INDEX idx_event_id;
ALTER TABLE audit_events MATERIALIZE INDEX idx_campaign_id;
ALTER TABLE audit_events MATERIALIZE INDEX idx_action;
ALTER TABLE audit_events MATERIALIZE INDEX idx_ingested_at;
