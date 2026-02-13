import cron from "node-cron";
import { runSync } from "./sync-service.js";
import { refreshCache } from "../cache.js";

export function startCronSync() {
  cron.schedule("*/60 * * * * *", async () => {
    try {
      await runSync();
      refreshCache();
    } catch (err) {
      console.error("Cron sync failed:", err);
    }
  });

  console.log("PostHog cron sync scheduled (every 60 seconds)");
}
