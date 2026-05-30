import { sqlite } from "@heatbrothers/db";
import {
  fetchEvents,
  countEvents,
  earliestEventTimestamp,
  SYNCED_EVENT_TYPES,
  RateLimitedError,
  type PostHogEvent,
} from "./posthog-client.js";

const BACKFILL_PAGE_SIZE = 50_000;
const BACKFILL_WINDOW_S = 7 * 24 * 60 * 60; // 7d windows — same shape as full-sync
const RETRY_DELAY_MS = 5 * 60 * 1000;
const COMPLETENESS_THRESHOLD = 0.99;

interface SyncStateRow {
  event_type: string;
  initial_full_sync_completed_at: number | null;
  backfill_cursor: number | null;
  local_count_at_complete: number | null;
  posthog_count_at_complete: number | null;
}

const insertStmt = sqlite.prepare(`
  INSERT OR IGNORE INTO events
    (posthog_id, event_type, latitude, longitude, geohash, timestamp, posthog_ts,
     distinct_id, env, event_source, pss_id, pss_name, pss_type,
     company_name, alarm_source)
  VALUES
    (@posthogId, @eventType, @latitude, @longitude, @geohash, @timestamp, @posthogTs,
     @distinctId, @env, @eventSource, @pssId, @pssName, @pssType,
     @companyName, @alarmSource)
`);

const insertMany = sqlite.transaction((events: PostHogEvent[]) => {
  let inserted = 0;
  for (const e of events) {
    const r = insertStmt.run({
      posthogId: e.uuid,
      eventType: e.event,
      latitude: e.latitude,
      longitude: e.longitude,
      geohash: e.geohash,
      timestamp: Number(e.timestamp),
      posthogTs: e.timestamp,
      distinctId: e.distinct_id,
      env: e.env ?? "prod",
      eventSource: e.eventSource,
      pssId: e.pssId,
      pssName: e.pssName,
      pssType: e.pssType,
      companyName: e.companyName,
      alarmSource: e.alarmSource,
    });
    inserted += r.changes;
  }
  return inserted;
});

export function getSyncState(eventType: string): SyncStateRow | undefined {
  return sqlite
    .prepare("SELECT * FROM sync_state WHERE event_type = ?")
    .get(eventType) as SyncStateRow | undefined;
}

function setBackfillCursor(eventType: string, cursor: number) {
  sqlite
    .prepare(
      `INSERT INTO sync_state (event_type, backfill_cursor) VALUES (?, ?)
       ON CONFLICT(event_type) DO UPDATE SET backfill_cursor = excluded.backfill_cursor`,
    )
    .run(eventType, cursor);
}

export function markInitialSyncComplete(
  eventType: string,
  localCount: number,
  posthogCount: number,
) {
  const now = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      `INSERT INTO sync_state
         (event_type, initial_full_sync_completed_at, local_count_at_complete, posthog_count_at_complete)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_type) DO UPDATE SET
         initial_full_sync_completed_at = excluded.initial_full_sync_completed_at,
         local_count_at_complete = excluded.local_count_at_complete,
         posthog_count_at_complete = excluded.posthog_count_at_complete`,
    )
    .run(eventType, now, localCount, posthogCount);
}

export function clearAllSyncState() {
  sqlite.prepare("DELETE FROM sync_state").run();
}

function getLocalCount(eventType: string): number {
  const r = sqlite
    .prepare("SELECT COUNT(*) as c FROM events WHERE event_type = ?")
    .get(eventType) as { c: number };
  return r.c;
}

/**
 * Ensures a single event type has been backfilled from PostHog.
 * - If already marked complete in sync_state, returns immediately.
 * - Otherwise, queries PostHog count and compares to local.
 *   - If within 99%: marks complete, no fetch needed.
 *   - If gap detected: full-fetches from PostHog (no upper bound) using INSERT OR IGNORE.
 *     Persists a resume cursor between batches so a crash/restart can continue.
 *
 * Throws RateLimitedError if PostHog rate-limits; caller should retry.
 */
export async function ensureBackfilled(eventType: string): Promise<void> {
  const state = getSyncState(eventType);
  if (state?.initial_full_sync_completed_at) return;

  const localCount = getLocalCount(eventType);
  const phCount = await countEvents(eventType);

  if (phCount > 0 && localCount >= phCount * COMPLETENESS_THRESHOLD) {
    markInitialSyncComplete(eventType, localCount, phCount);
    console.log(
      `[backfill] ${eventType}: already complete (${localCount}/${phCount}) — marked done`,
    );
    return;
  }

  console.warn(
    `[backfill] ${eventType}: gap detected (${localCount}/${phCount}) — backfilling`,
  );

  // Resume from saved cursor if present, else start from PostHog's earliest event.
  // Chunk into bounded time windows so each query stays well under the timeout.
  const resumeCursor = state?.backfill_cursor;
  const startEpoch =
    resumeCursor ?? (await earliestEventTimestamp(eventType));
  if (startEpoch == null) {
    markInitialSyncComplete(eventType, localCount, phCount);
    console.log(`[backfill] ${eventType}: PostHog has no events — marked done`);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  let windowStart = resumeCursor != null ? resumeCursor : startEpoch - 1;
  let total = 0;

  while (windowStart < now) {
    const windowEnd = Math.min(windowStart + BACKFILL_WINDOW_S, now + 3600);
    let windowInserted = 0;

    for await (const batch of fetchEvents(
      eventType,
      windowStart,
      BACKFILL_PAGE_SIZE,
      windowEnd,
    )) {
      const valid = batch.filter((e) => e.latitude != null && e.longitude != null);
      if (valid.length > 0) {
        const inserted = insertMany(valid);
        windowInserted += inserted;
        total += inserted;
      }
    }

    setBackfillCursor(eventType, windowEnd);
    if (windowInserted > 0) {
      console.log(
        `[backfill] ${eventType} window [${windowStart}..${windowEnd}]: +${windowInserted} (total=${total})`,
      );
    }
    windowStart = windowEnd;
  }

  const finalLocalCount = getLocalCount(eventType);
  const finalPhCount = await countEvents(eventType);
  markInitialSyncComplete(eventType, finalLocalCount, finalPhCount);
  console.log(
    `[backfill] ${eventType} ✓ complete — local=${finalLocalCount}, posthog=${finalPhCount}`,
  );
}

/**
 * Run ensureBackfilled for every type in SYNCED_EVENT_TYPES.
 * Designed to run in the background on app boot. Retries on failure with delay.
 */
export async function ensureAllBackfilled(): Promise<void> {
  while (true) {
    const pending = SYNCED_EVENT_TYPES.filter(
      (t) => !getSyncState(t)?.initial_full_sync_completed_at,
    );
    if (pending.length === 0) {
      console.log("[backfill] all event types verified");
      return;
    }

    console.log(`[backfill] checking ${pending.length} type(s): ${pending.join(", ")}`);

    let hadFailure = false;
    for (const t of pending) {
      try {
        await ensureBackfilled(t);
      } catch (err) {
        hadFailure = true;
        if (err instanceof RateLimitedError) {
          console.warn(`[backfill] ${t}: rate limited, will retry`);
        } else {
          console.error(`[backfill] ${t}: error`, err);
        }
      }
    }

    if (hadFailure) {
      const min = RETRY_DELAY_MS / 60_000;
      console.log(`[backfill] retrying remaining type(s) in ${min} min`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}
