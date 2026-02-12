import "../env.js";
import { runSync } from "./sync-service.js";

const eventType = process.argv[2] || undefined;
await runSync({ eventType });
process.exit(0);
