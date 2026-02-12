import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../",
);

dotenv.config({ path: path.join(ROOT_DIR, ".env") });
