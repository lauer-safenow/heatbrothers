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
export async function syncEventType(eventType: string): Promise<void> {
  const row = getLastEpoch.get({ event_type: eventType });
  const rawEpoch = row?.ts ?? undefined;
  const cursorEpoch = rawEpoch ? rawEpoch - LOOKBACK_S : undefined;

  console.log(`[sync] ${eventType} ${cursorEpoch != null ? `since epoch ${cursorEpoch} (lookback ${LOOKBACK_S}s from ${rawEpoch})` : "(full sync)"}`);

  let totalInserted = 0;
  let totalSkipped = 0;

  for await (const batch of fetchEvents(eventType, cursorEpoch)) {
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

/** Backfill a single event type from an explicit epoch, ignoring the stored cursor. */
export async function backfillEventType(eventType: string, sinceEpoch: number): Promise<number> {
  let totalInserted = 0;
  for await (const batch of fetchEvents(eventType, sinceEpoch)) {
    const validEvents = batch.filter((e) => e.latitude != null && e.longitude != null);
    if (validEvents.length === 0) continue;
    const inserted = insertMany(validEvents);
    totalInserted += inserted;
    const fmt = (epoch: number) =>
      new Date(epoch * 1000).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });
    const from = Number(batch[0].timestamp);
    const to = Number(batch[batch.length - 1].timestamp);
    console.log(`[backfill]   ${eventType}: +${inserted} (total ${totalInserted}) from=${fmt(from)} to=${fmt(to)}`);
  }
  console.log(`[backfill] Done ${eventType}: ${totalInserted} new events`);
  return totalInserted;
}

/** Backfill all event types from sinceEpoch. */
export async function runBackfill(sinceEpoch: number): Promise<void> {
  const total = SYNCED_EVENT_TYPES.length;
  console.log(`[backfill] Starting ${total} types from ${new Date(sinceEpoch * 1000).toISOString()}`);
  let grandTotal = 0;
  for (let i = 0; i < total; i++) {
    const eventType = SYNCED_EVENT_TYPES[i];
    console.log(`[backfill] [${i + 1}/${total}] ${eventType}`);
    const inserted = await backfillEventType(eventType, sinceEpoch);
    grandTotal += inserted;
  }
  console.log(`[backfill] Complete — ${grandTotal} total new events across ${total} types`);
}

export { LIVE_EVENT_TYPE, RateLimitedError };
