import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const defaultDataDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "AIMessenger",
);
const envFile =
  process.env.AIMESSENGER_ENV_FILE ?? path.join(defaultDataDir, "env");

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, quiet: true });
} else {
  dotenv.config({ quiet: true });
}

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  TELEGRAM_ALLOWED_USER_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_BASE: z.string().url().default("https://api.telegram.org"),
  AIMESSENGER_DATA_DIR: z.string().default(defaultDataDir),
  AIMESSENGER_WORKING_DIR: z.string().default(os.homedir()),
  AIMESSENGER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DEFAULT_PROVIDER: z.enum(["codex", "claude"]).default("codex"),
  JOB_TIMEOUT_MINUTES: z.coerce.number().positive().default(360),
  CODEX_COMMAND: z.string().default("codex"),
  CLAUDE_COMMAND: z.string().default("claude"),
});

export type Config = z.infer<typeof schema> & {
  appRoot: string;
  databasePath: string;
  jobsDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const resolvedRoot = appRoot.endsWith(`${path.sep}dist`)
    ? path.dirname(appRoot)
    : appRoot;
  return {
    ...parsed,
    appRoot: resolvedRoot,
    databasePath: path.join(parsed.AIMESSENGER_DATA_DIR, "aimessenger.sqlite"),
    jobsDir: path.join(parsed.AIMESSENGER_DATA_DIR, "jobs"),
  };
}
