-- CreateTable
CREATE TABLE "sync_state" (
    "event_type" TEXT NOT NULL PRIMARY KEY,
    "initial_full_sync_completed_at" INTEGER,
    "backfill_cursor" INTEGER,
    "local_count_at_complete" INTEGER,
    "posthog_count_at_complete" INTEGER
);
