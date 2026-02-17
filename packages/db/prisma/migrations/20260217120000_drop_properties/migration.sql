-- Drop the properties column — it was never queried by any route and was the
-- primary cause of OOM kills on the production server (full PostHog JSON blobs
-- stored per event). The column is nullable so existing rows are unaffected.
ALTER TABLE events DROP COLUMN properties;
