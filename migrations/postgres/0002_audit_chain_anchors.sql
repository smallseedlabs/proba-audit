-- Signed heads of the audit hash chains (AnchorStore). Apply this to a Postgres that is NOT the ClickHouse holding the
-- audit events and that the audit store's credentials cannot reach: the point of an anchor is that whoever can delete
-- the newest events cannot also rewrite the anchor. `signature` is HMAC-SHA256 with ANCHOR_HMAC_KEY (see docs/ARCHITECTURE.md).
-- `anchored_at` is the ingestedAt of the head event, kept as the exact text that was signed.
CREATE TABLE IF NOT EXISTS audit_chain_anchors (
  workspace_id TEXT        PRIMARY KEY,
  head_hash    TEXT        NOT NULL,
  count        BIGINT      NOT NULL CHECK (count >= 0),
  anchored_at  TEXT        NOT NULL,
  signature    TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
