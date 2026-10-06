// Loads ./.env (git-ignored local secrets) into process.env. Imported first by server.ts so every module sees it.
// Variables already set in the real environment (e.g. Render) take precedence; a missing file is fine.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
try {
  process.loadEnvFile(ENV_FILE);
} catch {}
