-- Reset events with poisoned timestamps from timezone bug.
-- toString(timestamp) returned Berlin-local strings that were parsed as UTC,
-- shifting all stored epochs +1h (CET) / +2h (CEST).
-- Deleting lets the sync re-fetch with correct toUnixTimestamp() epochs.
DELETE FROM events;
