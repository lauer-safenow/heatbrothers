import { sqlite } from "@heatbrothers/db";
import {
  fetchEvents,
  countEvents,
  earliestEventTimestamp,
  RateLimitedError,
  SYNCED_EVENT_TYPES,
  type PostHogEvent,
} from "./posthog-client.js";
import { LIVE_EVENT_TYPE } from "@heatbrothers/shared";
import { clearAllSyncState, markInitialSyncComplete } from "./backfill.js";

/** Window size for chunked full-syncs. Keeps each PostHog query well under the 120s timeout. */
export const FULL_SYNC_WINDOW_S = 7 * 24 * 60 * 60; // 7 days

/** All other types — synced on the slow cron (round-robin). */
export const SLOW_EVENT_TYPES = SYNCED_EVENT_TYPES.filter((t) => t !== LIVE_EVENT_TYPE);

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
    const result = insertStmt.run({
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
    inserted += result.changes;
  }
  return inserted;
});

const getLastEpoch = sqlite.prepare<{ event_type: string }, { ts: number | null }>(
  `SELECT MAX(timestamp) as ts FROM events WHERE event_type = @event_type`,
);

const LOOKBACK_S = 10 * 60; // 10 min lookback for ingestion delay (dedup via INSERT OR IGNORE)

/** Sync a single event type. Throws RateLimitedError on 429. */
export async function syncEventType(eventType: string, pageSize = 5_000): Promise<void> {
  const row = getLastEpoch.get({ event_type: eventType });
  const rawEpoch = row?.ts ?? undefined;
  const cursorEpoch = rawEpoch ? rawEpoch - LOOKBACK_S : undefined;

  console.log(`[sync] ${eventType} ${cursorEpoch != null ? `since epoch ${cursorEpoch} (lookback ${LOOKBACK_S}s from ${rawEpoch})` : "(full sync)"}`);

  let totalInserted = 0;
  let totalSkipped = 0;

  for await (const batch of fetchEvents(eventType, cursorEpoch, pageSize)) {
    const validEvents = batch.filter(
      (e) => e.latitude != null && e.longitude != null,
    );
    totalSkipped += batch.length - validEvents.length;

    if (validEvents.length === 0) continue;

    const inserted = insertMany(validEvents);
    totalInserted += inserted;

    console.log(
      `  Batch: ${inserted} inserted, ${batch.length - validEvents.length} skipped (total: ${totalInserted})`,
    );
  }

  console.log(`[sync] Done. ${totalInserted} new, ${totalSkipped} skipped.`);
}

/** Sync all event types (used by manual sync / run-sync script). */
export async function runSync(): Promise<void> {
  for (const eventType of SYNCED_EVENT_TYPES) {
    await syncEventType(eventType);
  }
}

/**
 * Full sync — explicitly ignores MAX(timestamp) and fetches everything from
 * PostHog using time-windowed chunks (default 7d). Each PostHog query is
 * bounded so it can use the timestamp index and stays well under the timeout.
 *
 * Used by hard-reset so concurrent inserts from cron can't poison the cursor
 * (the bug that previously caused app_opening_ZONE to end up with 32 events
 * instead of 445k). INSERT OR IGNORE dedupes against any concurrent inserts.
 *
 * Optional `fromEpoch`: resume from a known cursor (e.g. backfill_cursor).
 */
export async function fullSyncEventType(
  eventType: string,
  pageSize = 50_000,
  fromEpoch?: number,
): Promise<void> {
  const earliest = fromEpoch ?? (await earliestEventTimestamp(eventType));
  if (earliest == null) {
    console.log(`[full-sync] ${eventType}: PostHog has no events of this type`);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const totalSpanDays = ((now - earliest) / 86400).toFixed(1);
  console.log(
    `[full-sync] ${eventType} chunked from epoch ${earliest} (~${totalSpanDays}d span, ${FULL_SYNC_WINDOW_S / 86400}d/window, page=${pageSize})`,
  );

  let totalInserted = 0;
  let totalSkipped = 0;
  let windowStart = earliest - 1; // -1 because fetchEvents filters timestamp > since (exclusive)
  let windowIdx = 0;

  while (windowStart < now) {
    const windowEnd = Math.min(windowStart + FULL_SYNC_WINDOW_S, now + 3600);
    let windowInserted = 0;

    for await (const batch of fetchEvents(eventType, windowStart, pageSize, windowEnd)) {
      const validEvents = batch.filter(
        (e) => e.latitude != null && e.longitude != null,
      );
      totalSkipped += batch.length - validEvents.length;
      if (validEvents.length === 0) continue;
      const inserted = insertMany(validEvents);
      windowInserted += inserted;
      totalInserted += inserted;
    }

    if (windowInserted > 0) {
      console.log(
        `  window ${windowIdx} [${windowStart}..${windowEnd}]: +${windowInserted} (total: ${totalInserted})`,
      );
    }
    windowStart = windowEnd;
    windowIdx++;
  }

  console.log(`[full-sync] ${eventType} done — ${totalInserted} new, ${totalSkipped} skipped.`);
}

const fmtTime = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });

const RESET_RETRY_MS = 60_000;
const RESET_MAX_ATTEMPTS = 5;

function countLocalEvents(eventType: string): number {
  const r = sqlite
    .prepare("SELECT COUNT(*) as c FROM events WHERE event_type = ?")
    .get(eventType) as { c: number };
  return r.c;
}

/**
 * Delete all events and re-sync everything from PostHog from scratch (50k pages).
 *
 * Bulletproof version:
 *   - Caller must pause the cron via setCronPaused(true) before invoking, and
 *     resume on completion. (Done in the route handler.)
 *   - Uses fullSyncEventType() so concurrent inserts cannot poison the cursor.
 *   - Wipes sync_state along with events.
 *   - Retries per-type on transient failures.
 *   - Verifies local count vs PostHog count (≥99%) before marking each type
 *     complete in sync_state. Throws if any type can't reach that threshold.
 */
export async function hardReset(): Promise<void> {
  const { loadCache, refreshCache } = await import("../cache.js");
  const startedAt = new Date();
  console.log(`[hard-reset] Started at ${fmtTime(startedAt)}`);

  console.log("[hard-reset] Deleting all events and sync_state...");
  sqlite.prepare("DELETE FROM events").run();
  clearAllSyncState();

  console.log("[hard-reset] Clearing cache (app offline during reset)...");
  await loadCache();

  console.log("[hard-reset] Starting full re-sync (50k pages, no cursor)...");
  for (const eventType of SYNCED_EVENT_TYPES) {
    const t = Date.now();
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        console.log(`[hard-reset] Syncing ${eventType} (attempt ${attempt})...`);
        await fullSyncEventType(eventType, 50_000);
        break;
      } catch (err) {
        if (attempt >= RESET_MAX_ATTEMPTS) {
          console.error(`[hard-reset] ${eventType}: gave up after ${attempt} attempts`);
          throw err;
        }
        const isRateLimit = err instanceof RateLimitedError;
        const delay = isRateLimit ? RESET_RETRY_MS * 2 : RESET_RETRY_MS;
        console.warn(
          `[hard-reset] ${eventType}: attempt ${attempt} failed (${isRateLimit ? "429" : String(err)}), retrying in ${delay / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const localCount = countLocalEvents(eventType);
    const phCount = await countEvents(eventType);
    if (phCount > 0 && localCount < phCount * 0.99) {
      throw new Error(
        `[hard-reset] ${eventType}: incomplete (${localCount}/${phCount}) — aborting`,
      );
    }
    markInitialSyncComplete(eventType, localCount, phCount);

    refreshCache();
    console.log(
      `[hard-reset] Done ${eventType} in ${((Date.now() - t) / 1000).toFixed(1)}s — local=${localCount}, posthog=${phCount}`,
    );
  }

  const finishedAt = new Date();
  const elapsedMin = ((finishedAt.getTime() - startedAt.getTime()) / 60_000).toFixed(1);
  console.log(`[hard-reset] Complete. Finished at ${fmtTime(finishedAt)} (took ${elapsedMin} min)`);
}

export { LIVE_EVENT_TYPE, RateLimitedError };
