import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../prisma/generated/prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../../data");
const dbPath = path.resolve(dataDir, "heatbrothers.db");

fs.mkdirSync(dataDir, { recursive: true });

const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath}` });
export const prisma = new PrismaClient({ adapter });

export { PrismaClient } from "../prisma/generated/prisma/client";
export type { Event, SyncState } from "../prisma/generated/prisma/client";
