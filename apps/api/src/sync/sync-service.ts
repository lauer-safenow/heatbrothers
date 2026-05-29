import { sqlite } from "@heatbrothers/db";
import { fetchEvents, RateLimitedError, SYNCED_EVENT_TYPES, type PostHogEvent } from "./posthog-client.js";
import { LIVE_EVENT_TYPE } from "@heatbrothers/shared";

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

const fmtTime = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });

/** Delete all events and re-sync everything from PostHog from scratch (50k pages). */
export async function hardReset(): Promise<void> {
  const { loadCache, refreshCache } = await import("../cache.js");
  const startedAt = new Date();
  console.log(`[hard-reset] Started at ${fmtTime(startedAt)}`);
  console.log("[hard-reset] Deleting all events...");
  sqlite.prepare("DELETE FROM events").run();
  console.log("[hard-reset] Clearing cache (app offline during reset)...");
  await loadCache(); // reloads from empty DB → zeroes out the cache
  console.log("[hard-reset] Starting full re-sync (50k pages)...");
  for (const eventType of SYNCED_EVENT_TYPES) {
    const t = Date.now();
    console.log(`[hard-reset] Syncing ${eventType}...`);
    await syncEventType(eventType, 50_000);
    refreshCache(); // bring this type's data back into cache immediately
    console.log(`[hard-reset] Done ${eventType} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  const finishedAt = new Date();
  const elapsedMin = ((finishedAt.getTime() - startedAt.getTime()) / 60_000).toFixed(1);
  console.log(`[hard-reset] Complete. Finished at ${fmtTime(finishedAt)} (took ${elapsedMin} min)`);
}

export { LIVE_EVENT_TYPE, RateLimitedError };
