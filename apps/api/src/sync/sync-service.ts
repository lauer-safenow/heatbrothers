import { sqlite } from "@heatbrothers/db";
import { fetchEvents, SYNCED_EVENT_TYPES, type PostHogEvent } from "./posthog-client.js";

const insertStmt = sqlite.prepare(`
  INSERT OR IGNORE INTO events
    (posthog_id, event_type, latitude, longitude, geohash, timestamp, posthog_ts,
     distinct_id, env, event_source, pss_id, pss_name, pss_type,
     company_name, alarm_source, properties)
  VALUES
    (@posthogId, @eventType, @latitude, @longitude, @geohash, @timestamp, @posthogTs,
     @distinctId, @env, @eventSource, @pssId, @pssName, @pssType,
     @companyName, @alarmSource, @properties)
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
      timestamp: Math.floor(new Date(e.timestamp).getTime() / 1000),
      posthogTs: e.timestamp,
      distinctId: e.distinct_id,
      env: e.env ?? "prod",
      eventSource: e.eventSource,
      pssId: e.pssId,
      pssName: e.pssName,
      pssType: e.pssType,
      companyName: e.companyName,
      alarmSource: e.alarmSource,
      properties: e.properties,
    });
    inserted += result.changes;
  }
  return inserted;
});

const getLastPosthogTs = sqlite.prepare<{ event_type: string }, { ts: string | null }>(
  `SELECT MAX(posthog_ts) as ts FROM events WHERE event_type = @event_type`,
);

async function syncEventType(eventType: string): Promise<{ inserted: number; skipped: number }> {
  const row = getLastPosthogTs.get({ event_type: eventType });
  const cursor = row?.ts || undefined;

  if (cursor) {
    console.log(`  [${eventType}] Incremental sync since: ${cursor}`);
  } else {
    console.log(`  [${eventType}] Full sync (no previous events)`);
  }

  let totalInserted = 0;
  let totalSkipped = 0;

  for await (const batch of fetchEvents(eventType, cursor)) {
    const validEvents = batch.filter(
      (e) => e.latitude != null && e.longitude != null,
    );
    totalSkipped += batch.length - validEvents.length;

    if (validEvents.length === 0) continue;

    const inserted = insertMany(validEvents);
    totalInserted += inserted;

    console.log(
      `  [${eventType}] Batch: ${inserted} inserted, ${batch.length - validEvents.length} skipped. Total: ${totalInserted}`,
    );
  }

  return { inserted: totalInserted, skipped: totalSkipped };
}

export async function runSync(): Promise<void> {
  console.log("Starting PostHog sync...");

  let grandInserted = 0;
  let grandSkipped = 0;

  for (const eventType of SYNCED_EVENT_TYPES) {
    const { inserted, skipped } = await syncEventType(eventType);
    grandInserted += inserted;
    grandSkipped += skipped;
  }

  const totalEvents = sqlite.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };
  console.log(
    `Sync complete. ${grandInserted} new, ${grandSkipped} skipped. DB total: ${totalEvents.cnt}`,
  );
}
