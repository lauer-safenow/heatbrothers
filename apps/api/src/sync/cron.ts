import cron from "node-cron";
import { syncEventType, LIVE_EVENT_TYPE, SLOW_EVENT_TYPES, RateLimitedError } from "./sync-service.js";
import { refreshCache } from "../cache.js";
import { SYNC_INTERVAL_S, SLOW_SYNC_INTERVAL_M } from "@heatbrothers/shared";

const COOLDOWN_CYCLES = 2;

// ── Job queue ────────────────────────────────────────────────────────────────
// Jobs are deduplicated: enqueueing "fast" while "fast" is already queued is a
// no-op. This way the slow cron never gets silently dropped — it waits in line
// behind the fast job and executes as soon as it finishes.

type Job = "fast" | "slow";

const queue: Job[] = [];
let running = false;
let fastCooldown = 0;
let paused = false;

/** Pause/resume cron execution. Used during hard-reset to avoid races. */
export function setCronPaused(value: boolean) {
  paused = value;
  console.log(`[cron] ${paused ? "paused" : "resumed"}`);
}

/** True while a cron job is mid-flight. */
export function isCronRunning(): boolean {
  return running;
}

function enqueue(job: Job) {
  if (paused) return;
  if (queue.includes(job)) return; // already waiting, don't duplicate
  queue.push(job);
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    await run(job);
  }
  running = false;
}

async function run(job: Job) {
  if (job === "fast") {
    try {
      await syncEventType(LIVE_EVENT_TYPE);
      refreshCache();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        fastCooldown = COOLDOWN_CYCLES;
        console.warn(`[cron:fast] 429 — cooldown ${COOLDOWN_CYCLES} cycles`);
      } else {
        console.error("[cron:fast] failed:", err);
      }
    }
  } else {
    console.log(`[cron:slow] Syncing ${SLOW_EVENT_TYPES.length} types...`);
    for (const eventType of SLOW_EVENT_TYPES) {
      try {
        await syncEventType(eventType);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          console.warn("[cron:slow] 429 — skipping remaining types");
          break;
        }
        console.error("[cron:slow] failed:", err);
      }
    }
    refreshCache();
  }
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export function startCronSync() {
  cron.schedule(`*/${SYNC_INTERVAL_S} * * * * *`, () => {
    if (fastCooldown > 0) {
      console.log(`[cron:fast] Cooldown (${fastCooldown} left)`);
      fastCooldown--;
      return;
    }
    enqueue("fast");
  });

  // node-cron 3.0.3: */N in the minutes field is broken (collapses to 0 only).
  // Use explicit list to bypass step-values-conversion.
  const slowMinutes = Array.from(
    { length: Math.floor(60 / SLOW_SYNC_INTERVAL_M) },
    (_, i) => i * SLOW_SYNC_INTERVAL_M,
  ).join(",");
  cron.schedule(`0 ${slowMinutes} * * * *`, () => {
    enqueue("slow");
  });

  console.log(`PostHog sync: fast=${SYNC_INTERVAL_S}s (${LIVE_EVENT_TYPE}), slow=${SLOW_SYNC_INTERVAL_M}min (${SLOW_EVENT_TYPES.length} types)`);
}
