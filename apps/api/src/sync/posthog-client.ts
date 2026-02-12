import "dotenv/config";

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY!;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://app.posthog.com";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID!;

const QUERY_URL = `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`;
const PAGE_SIZE = 10_000;

export interface PostHogGeoEvent {
  uuid: string;
  event: string;
  timestamp: string;
  distinct_id: string;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  country: string | null;
  properties: string;
}

async function hogqlQuery(query: string): Promise<{
  columns: string[];
  results: unknown[][];
}> {
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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HogQL query failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    columns: data.columns ?? [],
    results: data.results ?? [],
  };
}

/**
 * Fetch geo-located events from PostHog since a given timestamp.
 * Yields batches of events using LIMIT/OFFSET pagination.
 */
export async function* fetchGeoEvents(
  sinceTimestamp?: string,
  eventTypeFilter?: string,
): AsyncGenerator<PostHogGeoEvent[]> {
  let offset = 0;

  while (true) {
    const conditions: string[] = [
      "properties.$geoip_latitude IS NOT NULL",
      "properties.$geoip_longitude IS NOT NULL",
    ];

    if (sinceTimestamp) {
      conditions.push(`timestamp > '${sinceTimestamp}'`);
    }

    if (eventTypeFilter) {
      conditions.push(`event = '${eventTypeFilter}'`);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const query = `
      SELECT
        uuid,
        event,
        toString(timestamp) as timestamp,
        distinct_id,
        properties.$geoip_latitude as latitude,
        properties.$geoip_longitude as longitude,
        properties.$geoip_city_name as city,
        properties.$geoip_country_name as country,
        properties
      FROM events
      ${whereClause}
      ORDER BY timestamp ASC
      LIMIT ${PAGE_SIZE}
      OFFSET ${offset}
    `;

    const result = await hogqlQuery(query);

    if (result.results.length === 0) break;

    const events: PostHogGeoEvent[] = result.results.map((row) => ({
      uuid: row[0] as string,
      event: row[1] as string,
      timestamp: row[2] as string,
      distinct_id: row[3] as string,
      latitude: row[4] as number | null,
      longitude: row[5] as number | null,
      city: row[6] as string | null,
      country: row[7] as string | null,
      properties: typeof row[8] === "string" ? row[8] : JSON.stringify(row[8]),
    }));

    yield events;

    if (result.results.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;

    // Gentle throttle between batches (rate limit: 120 queries/hour)
    await new Promise((r) => setTimeout(r, 1000));
  }
}
