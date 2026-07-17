import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { getDefaultDataDir, getDefaultEnvFile } from "./defaults.js";
import type { ProviderName } from "./types.js";

const defaultDataDir = getDefaultDataDir(process.platform, process.env, os.homedir());
const envFile = process.env.AIMESSENGER_ENV_FILE ?? getDefaultEnvFile(process.platform, process.env, os.homedir());

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
  SELF_UPDATE_ENABLED: z.coerce.boolean().default(true),
  SELF_UPDATE_DRAIN_SECONDS: z.coerce.number().int().min(1).max(300).default(45),
  SELF_UPDATE_WATCHDOG_SECONDS: z.coerce.number().int().min(15).max(300).default(90),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_LIVE_CONVERSATIONS: z.coerce.boolean().default(true),
  CLAUDE_COMMAND: z.string().default("claude"),
  CODEX_MODEL: z.string().min(1).optional(),
  CLAUDE_MODEL: z.string().min(1).optional(),
  GATEWAY_API_BASE: z.string().url().default("http://127.0.0.1:4000/v1"),
  GATEWAY_API_KEY: z.string().min(1).optional(),
  GATEWAY_MODELS: z
    .string()
    .default("glm-5.2,deepseek-v4-flash,deepseek-v4-pro"),
});

export type Config = z.infer<typeof schema> & {
  appRoot: string;
  databasePath: string;
  memoryDir: string;
  memoryCliPath: string;
  jobsDir: string;
  logsDir: string;
  identityPath: string;
  skillsDir: string;
  selfUpdateSourceDir: string;
  selfUpdateReleasesDir: string;
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
    memoryDir: path.join(parsed.AIMESSENGER_DATA_DIR, "memory"),
    memoryCliPath: path.join(resolvedRoot, "dist", "src", "memory-cli.js"),
    jobsDir: path.join(parsed.AIMESSENGER_DATA_DIR, "jobs"),
    logsDir: path.join(parsed.AIMESSENGER_DATA_DIR, "logs"),
    identityPath: path.join(resolvedRoot, "IDENTITY.md"),
    skillsDir: path.join(resolvedRoot, "skills"),
    selfUpdateSourceDir: path.join(parsed.AIMESSENGER_WORKING_DIR, "source"),
    selfUpdateReleasesDir: path.join(parsed.AIMESSENGER_WORKING_DIR, "releases"),
  };
}

export function getProviderModel(
  config: Config,
  provider: ProviderName,
  selectedModel?: string,
): string | undefined {
  return selectedModel ?? (provider === "codex" ? config.CODEX_MODEL : config.CLAUDE_MODEL);
}

export function displayProviderModel(model: string | undefined): string {
  return model ?? "CLI default (not pinned)";
}

export function isGatewayModel(config: Pick<Config, "GATEWAY_MODELS">, model: string | undefined): boolean {
  if (!model) return false;
  return (config.GATEWAY_MODELS ?? "")
    .split(",")
    .some((candidate) => candidate.trim() === model);
}
