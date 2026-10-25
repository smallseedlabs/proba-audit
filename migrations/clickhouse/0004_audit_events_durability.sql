-- Acknowledged means durable. The audit consumer XACKs a message only after the
-- insert returned, so make ClickHouse fsync each inserted part (and its directory)
-- before it reports success. Without this a power loss can drop recently
-- acknowledged parts that were still in the OS page cache.
ALTER TABLE audit_events MODIFY SETTING fsync_after_insert = 1, fsync_part_directory = 1;
