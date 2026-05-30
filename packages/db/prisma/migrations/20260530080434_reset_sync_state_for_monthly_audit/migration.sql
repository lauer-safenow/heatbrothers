-- Older code used a 99% total-count shortcut that could mark a type "complete"
-- while ~200 historical events were still missing. The new ensureBackfilled
-- uses per-month count comparison and exact-match on past months. Clear the
-- completion timestamps so existing servers re-audit once with the new logic.
UPDATE "sync_state" SET "initial_full_sync_completed_at" = NULL;
