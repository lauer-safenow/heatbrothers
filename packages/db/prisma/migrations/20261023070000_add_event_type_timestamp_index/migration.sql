-- MAX(timestamp) WHERE event_type = ? (sync cursor) scanned every row of the
-- type via idx_event_type — up to ~3s cold on 4M rows, blocking the event loop
-- at the cron tick. Composite index turns it into a single index seek.
CREATE INDEX "idx_event_type_timestamp" ON "events"("event_type", "timestamp");
