import "../env.js";
import { runSync } from "./sync-service.js";

await runSync();
process.exit(0);
