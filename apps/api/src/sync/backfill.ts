import { sqlite } from "@heatbrothers/db";
import {
  fetchEvents,
  countEvents,
  monthlyEventCounts,
  SYNCED_EVENT_TYPES,
  RateLimitedError,
  type PostHogEvent,
} from "./posthog-client.js";

const BACKFILL_PAGE_SIZE = 50_000;
const BACKFILL_WINDOW_S = 7 * 24 * 60 * 60; // 7d sub-windows inside a month
const RETRY_DELAY_MS = 5 * 60 * 1000;

// Tolerated drift inside the current calendar month (real-time events keep arriving).
// For *past* months we require an exact match.
const CURRENT_MONTH_DRIFT_TOLERANCE = 50;

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

function getLocalMonthlyCounts(eventType: string): Map<number, number> {
  // SQLite: bucket each event by its calendar month (UTC), expressed as unix seconds
  // of the month's first day. Matches PostHog's toStartOfMonth grouping.
  const rows = sqlite
    .prepare(
      `SELECT
         CAST(strftime('%s', datetime(timestamp, 'unixepoch', 'start of month')) AS INTEGER) as month,
         COUNT(*) as cnt
       FROM events
       WHERE event_type = ?
       GROUP BY month`,
    )
    .all(eventType) as { month: number; cnt: number }[];
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.month, r.cnt);
  return map;
}

function startOfCurrentMonthEpoch(): number {
  const d = new Date();
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Math.floor(monthStart / 1000);
}

/**
 * Ensures a single event type has been backfilled from PostHog.
 *
 * Uses per-month count comparison (not a single 99% total check) to detect
 * structural drift that a total-count threshold would mask. For each month
 * where local count < PostHog count, fetches that month in chunked windows.
 * Past months must match exactly; the current month tolerates a small drift
 * (real-time events keep arriving while we run).
 *
 * Idempotent — INSERT OR IGNORE dedupes against existing rows. Persists
 * backfill_cursor between windows so a crash/restart resumes.
 *
 * Throws RateLimitedError on 429; caller should retry.
 */
export async function ensureBackfilled(eventType: string): Promise<void> {
  const state = getSyncState(eventType);
  if (state?.initial_full_sync_completed_at) return;

  const phMonthly = await monthlyEventCounts(eventType);
  if (phMonthly.size === 0) {
    markInitialSyncComplete(eventType, 0, 0);
    console.log(`[backfill] ${eventType}: PostHog has no events — marked done`);
    return;
  }

  const localMonthly = getLocalMonthlyCounts(eventType);
  const currentMonthStart = startOfCurrentMonthEpoch();

  const gapMonths: { monthStart: number; local: number; ph: number }[] = [];
  for (const [monthStart, phCnt] of phMonthly) {
    const localCnt = localMonthly.get(monthStart) ?? 0;
    const tolerance = monthStart === currentMonthStart ? CURRENT_MONTH_DRIFT_TOLERANCE : 0;
    if (phCnt - localCnt > tolerance) {
      gapMonths.push({ monthStart, local: localCnt, ph: phCnt });
    }
  }

  if (gapMonths.length === 0) {
    const localTotal = getLocalCount(eventType);
    const phTotal = [...phMonthly.values()].reduce((a, b) => a + b, 0);
    markInitialSyncComplete(eventType, localTotal, phTotal);
    console.log(`[backfill] ${eventType}: all months match — marked done`);
    return;
  }

  console.warn(
    `[backfill] ${eventType}: ${gapMonths.length} month(s) drifted — ` +
      gapMonths
        .map((g) => `${new Date(g.monthStart * 1000).toISOString().slice(0, 7)} (${g.local}/${g.ph})`)
        .join(", "),
  );

  // Backfill each gapped month using 7d sub-windows. INSERT OR IGNORE handles dedup.
  let totalInserted = 0;
  for (const gap of gapMonths) {
    const monthEnd = Math.min(gap.monthStart + 32 * 86400, Math.floor(Date.now() / 1000) + 3600);
    let windowStart = gap.monthStart - 1; // -1 because fetchEvents is exclusive on the lower bound
    while (windowStart < monthEnd) {
      const windowEnd = Math.min(windowStart + BACKFILL_WINDOW_S, monthEnd);
      for await (const batch of fetchEvents(
        eventType,
        windowStart,
        BACKFILL_PAGE_SIZE,
        windowEnd,
      )) {
        const valid = batch.filter((e) => e.latitude != null && e.longitude != null);
        if (valid.length > 0) totalInserted += insertMany(valid);
      }
      setBackfillCursor(eventType, windowEnd);
      windowStart = windowEnd;
    }
  }

  const finalLocal = getLocalCount(eventType);
  const finalPh = await countEvents(eventType);
  markInitialSyncComplete(eventType, finalLocal, finalPh);
  console.log(
    `[backfill] ${eventType} ✓ done — +${totalInserted} inserted, local=${finalLocal}, posthog=${finalPh}`,
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
