import cron from "node-cron";
import { runSync } from "./sync-service.js";

export function startCronSync() {
  cron.schedule("*/10 * * * * *", async () => {
    try {
      await runSync();
    } catch (err) {
      console.error("Cron sync failed:", err);
    }
  });

  console.log("PostHog cron sync scheduled (every 10 seconds)");
}
