import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clearSelfUpdateLock,
  markReleasePhase,
  readSelfUpdateState,
  rollbackRelease,
} from "./self-update.js";

export interface WatchdogArgs {
  workspace: string;
  dataDir: string;
  port: number;
  releaseId: string;
  timeoutSeconds: number;
}

export function parseWatchdogArgs(args: string[]): WatchdogArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Invalid watchdog arguments.");
    values.set(key.slice(2), value);
  }
  const workspace = values.get("workspace");
  const dataDir = values.get("data-dir");
  const releaseId = values.get("release-id");
  const port = Number(values.get("port"));
  const timeoutSeconds = Number(values.get("timeout-seconds"));
  if (
    !workspace ||
    !dataDir ||
    !releaseId ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 15 ||
    timeoutSeconds > 300
  ) {
    throw new Error("Missing watchdog arguments.");
  }
  return { workspace, dataDir, releaseId, port, timeoutSeconds };
}

export async function waitForHealthyRelease(args: WatchdogArgs, pollIntervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + args.timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${args.port}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await response.json()) as { ok?: unknown; releaseId?: unknown };
      if (response.ok && body.ok === true && body.releaseId === args.releaseId) return true;
    } catch {
      // The replacement service may still be restarting.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

export async function superviseRelease(
  args: WatchdogArgs,
  pollIntervalMs = 1_000,
): Promise<"healthy" | "rolled_back" | "not_current"> {
  try {
    if (await waitForHealthyRelease(args, pollIntervalMs)) {
      markReleasePhase(args.dataDir, args.releaseId, "healthy");
      return "healthy";
    }
    const current = readSelfUpdateState(args.dataDir);
    if (!current || current.currentReleaseId !== args.releaseId) return "not_current";
    const restored = rollbackRelease(args.workspace, args.dataDir);
    markReleasePhase(
      args.dataDir,
      restored.currentReleaseId,
      "rolled_back",
      `Release ${args.releaseId} did not pass its health check.`,
    );
    return "rolled_back";
  } finally {
    clearSelfUpdateLock(args.dataDir, args.releaseId);
  }
}

export function isWatchdogEntrypoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isWatchdogEntrypoint(import.meta.url, process.argv[1])) {
  superviseRelease(parseWatchdogArgs(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
