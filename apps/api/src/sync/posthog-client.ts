import "../env.js";

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY!;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://app.posthog.com";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID!;

const QUERY_URL = `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`;
const PAGE_SIZE = 10_000;

export const SYNCED_EVENT_TYPES = [
  "FIRST_TIME_PHONE_STATUS_SENT",
  "app_opening_ZONE",
  "DETAILED_ALARM_STARTED_ZONE",
  "DETAILED_ALARM_STARTED_PRIVATE_GROUP",
];

export interface PostHogEvent {
  uuid: string;
  event: string;
  timestamp: string;
  distinct_id: string;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;
  env: string | null;
  eventSource: string | null;
  pssId: string | null;
  pssName: string | null;
  pssType: string | null;
  companyName: string | null;
  alarmSource: string | null;
  properties: string;
}

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2_000;

async function hogqlQuery(query: string): Promise<{
  columns: string[];
  results: unknown[][];
}> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[PostHog] Querying ${POSTHOG_HOST}...`);
    const start = Date.now();

    const response = await fetch(QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${POSTHOG_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query,
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (!response.ok) {
      const text = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`[PostHog] ${response.status} error (${elapsed}s), retrying in ${backoff / 1000}s... (${attempt}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw new Error(`HogQL query failed (${response.status}, ${elapsed}s): ${text}`);
    }

    const data = (await response.json()) as { columns?: string[]; results?: unknown[][] };
    console.log(`[PostHog] Got ${data.results?.length ?? 0} rows in ${elapsed}s`);
    return {
      columns: data.columns ?? [],
      results: data.results ?? [],
    };
  }

  throw new Error("Unreachable");
}

/**
 * Fetch geo-located events of a single type from PostHog.
 * Uses timestamp-based cursor pagination (OFFSET gets slow at high values).
 */
export async function* fetchEvents(
  eventType: string,
  sinceTimestamp?: string,
): AsyncGenerator<PostHogEvent[]> {
  let cursor = sinceTimestamp;

  while (true) {
    const conditions: string[] = [
      "properties.latitude IS NOT NULL",
      "properties.longitude IS NOT NULL",
      "properties.env = 'prod'",
      `event = '${eventType}'`,
    ];

    if (cursor) {
      conditions.push(`timestamp > '${cursor}'`);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const query = `
      SELECT
        uuid,
        event,
        toString(timestamp) as timestamp,
        distinct_id,
        properties.latitude as latitude,
        properties.longitude as longitude,
        properties.geohash as geohash,
        properties.env as env,
        properties.eventSource as event_source,
        properties.pssId as pss_id,
        properties.pssName as pss_name,
        properties.pssType as pss_type,
        properties.companyName as company_name,
        properties.alarmSource as alarm_source,
        properties
      FROM events
      ${whereClause}
      ORDER BY timestamp ASC
      LIMIT ${PAGE_SIZE}
    `;

    const result = await hogqlQuery(query);

    if (result.results.length === 0) break;

    const events: PostHogEvent[] = result.results.map((row) => ({
      uuid: row[0] as string,
      event: row[1] as string,
      timestamp: row[2] as string,
      distinct_id: row[3] as string,
      latitude: row[4] as number | null,
      longitude: row[5] as number | null,
      geohash: row[6] as string | null,
      env: row[7] as string | null,
      eventSource: row[8] as string | null,
      pssId: row[9] as string | null,
      pssName: row[10] as string | null,
      pssType: row[11] as string | null,
      companyName: row[12] as string | null,
      alarmSource: row[13] as string | null,
      properties: typeof row[14] === "string" ? row[14] : JSON.stringify(row[14]),
    }));

    yield events;

    if (result.results.length < PAGE_SIZE) break;

    // Use last event's timestamp as cursor for next page
    cursor = events[events.length - 1].timestamp;

    // Gentle throttle between batches (rate limit: 120 queries/hour)
    await new Promise((r) => setTimeout(r, 1000));
  }
}
