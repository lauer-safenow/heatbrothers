import { prisma } from "@heatbrothers/db";
import { fetchGeoEvents } from "./posthog-client.js";

export async function runSync(opts: { eventType?: string } = {}): Promise<void> {
  console.log("Starting PostHog sync...");

  const lastSync = await prisma.syncState.findUnique({
    where: { key: "last_sync_timestamp" },
  });
  const sinceTimestamp = lastSync?.value ?? undefined;

  if (sinceTimestamp) {
    console.log(`Incremental sync since: ${sinceTimestamp}`);
  } else {
    console.log("Full sync (no previous timestamp found)");
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let latestTimestamp: string | null = null;

  for await (const batch of fetchGeoEvents(sinceTimestamp, opts.eventType)) {
    const validEvents = batch.filter(
      (e) => e.latitude != null && e.longitude != null,
    );
    totalSkipped += batch.length - validEvents.length;

    if (validEvents.length === 0) continue;

    const result = await prisma.event.createMany({
      data: validEvents.map((e) => ({
        posthogId: e.uuid,
        eventType: e.event,
        latitude: e.latitude!,
        longitude: e.longitude!,
        timestamp: Math.floor(new Date(e.timestamp).getTime() / 1000),
        city: e.city,
        country: e.country,
        properties: e.properties,
      })),
      skipDuplicates: true,
    });

    totalInserted += result.count;

    const batchLatest = validEvents[validEvents.length - 1].timestamp;
    if (!latestTimestamp || batchLatest > latestTimestamp) {
      latestTimestamp = batchLatest;
    }

    console.log(
      `Batch: ${result.count} inserted, ${batch.length - validEvents.length} skipped (no geo). Total: ${totalInserted}`,
    );
  }

  if (latestTimestamp) {
    await prisma.syncState.upsert({
      where: { key: "last_sync_timestamp" },
      update: { value: latestTimestamp },
      create: { key: "last_sync_timestamp", value: latestTimestamp },
    });
  }

  const totalEvents = await prisma.event.count();
  console.log(
    `Sync complete. ${totalInserted} new, ${totalSkipped} skipped. DB total: ${totalEvents}`,
  );
}
