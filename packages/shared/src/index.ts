/** Sync interval in seconds — used by cron, API polling, and live UI countdown */
export const SYNC_INTERVAL_S = 30;

/** Slow sync interval in minutes — used by cron for background event types */
export const SLOW_SYNC_INTERVAL_M = 30;

/** The event type used by the live map */
export const LIVE_EVENT_TYPE = "app_opening_ZONE";

/** The event type used for zone-specific replay */
export const ZONE_EVENT_TYPE = "DETAILED_ALARM_STARTED_ZONE";

/** Max events returned by the replay between endpoint */
export const REPLAY_MAX_EVENTS = 5_000;
