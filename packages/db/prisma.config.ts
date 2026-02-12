import fs from "fs";
import dotenv from "dotenv";
import path from "path";
import { defineConfig } from "prisma/config";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const dataDir = path.resolve(__dirname, "../../data");
fs.mkdirSync(dataDir, { recursive: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: `file:${path.resolve(dataDir, "heatbrothers.db")}`,
  },
});
