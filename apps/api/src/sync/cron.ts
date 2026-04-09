import cron from "node-cron";
import { syncEventType, LIVE_EVENT_TYPE, SLOW_EVENT_TYPES, RateLimitedError } from "./sync-service.js";
import { refreshCache } from "../cache.js";
import { SYNC_INTERVAL_S, SLOW_SYNC_INTERVAL_M } from "@heatbrothers/shared";

const COOLDOWN_CYCLES = 2;

/** Mutex to prevent fast + slow crons from writing to SQLite simultaneously. */
let syncLock = false;

async function withSyncLock<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (syncLock) {
    console.log(`[${label}] Skipped — another sync is in progress`);
    return undefined;
  }
  syncLock = true;
  try {
    return await fn();
  } finally {
    syncLock = false;
  }
}

export function startCronSync() {
  // ── Fast cron: live event type every SYNC_INTERVAL_S ──
  let fastCooldown = 0;

  cron.schedule(`*/${SYNC_INTERVAL_S} * * * * *`, async () => {
    if (fastCooldown > 0) {
      console.log(`[cron:fast] Cooldown (${fastCooldown} left)`);
      fastCooldown--;
      return;
    }
    await withSyncLock("cron:fast", async () => {
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
    });
  });

  // ── Slow cron: all other types every 10 min with random stagger between each ──
  cron.schedule(`*/${SLOW_SYNC_INTERVAL_M} * * * *`, async () => {
    await withSyncLock("cron:slow", async () => {
      console.log(`[cron:slow] Syncing ${SLOW_EVENT_TYPES.length} types...`);
      for (let i = 0; i < SLOW_EVENT_TYPES.length; i++) {
        // random delay: random(5-10) * (i+1) seconds
        const baseDelay = Math.floor(Math.random() * 6) + 5; // 5-10
        const delay = baseDelay * (i + 1);
        if (i > 0) {
          console.log(`[cron:slow] Waiting ${delay}s before next type...`);
          await new Promise((r) => setTimeout(r, delay * 1000));
        }
        try {
          await syncEventType(SLOW_EVENT_TYPES[i]);
        } catch (err) {
          if (err instanceof RateLimitedError) {
            console.warn(`[cron:slow] 429 — skipping remaining types`);
            break;
          }
          console.error("[cron:slow] failed:", err);
        }
      }
      refreshCache();
    });
  });

  console.log(`PostHog sync: fast=${SYNC_INTERVAL_S}s (${LIVE_EVENT_TYPE}), slow=${SLOW_SYNC_INTERVAL_M}min (${SLOW_EVENT_TYPES.length} types)`);
}
