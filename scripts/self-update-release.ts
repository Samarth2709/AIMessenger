import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  activateRelease,
  getReleasePaths,
  newReleaseId,
  startReleaseWatchdog,
  setSelfUpdateLockRelease,
  writeRestartRequest,
  writeReleaseMetadata,
} from "../src/self-update.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
}

function revision(source: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return "unversioned";
  const dirty = spawnSync("git", ["status", "--porcelain"], {
    cwd: source,
    encoding: "utf8",
    env: process.env,
  });
  return `${result.stdout.trim()}${dirty.stdout.trim() ? "-dirty" : ""}`;
}

function copyRelease(source: string, destination: string): void {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return ![".git", ".env", "coverage", "data"].includes(name);
    },
  });
}

function acquireLock(dataDir: string): (remove: boolean) => void {
  const lockPath = path.join(dataDir, "self-update.lock");
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error("A self-update is already running.");
  }
  fs.writeFileSync(descriptor, `${process.pid}\n`);
  let closed = false;
  return (remove) => {
    if (!closed) {
      fs.closeSync(descriptor);
      closed = true;
    }
    if (remove) fs.rmSync(lockPath, { force: true });
  };
}

function main(): void {
  const workspaceEnv = process.env.AIMESSENGER_WORKING_DIR;
  const dataDirEnv = process.env.AIMESSENGER_DATA_DIR;
  if (!workspaceEnv || !dataDirEnv) {
    throw new Error("AIMESSENGER_WORKING_DIR and AIMESSENGER_DATA_DIR must be configured.");
  }
  const workspace = path.resolve(workspaceEnv);
  const dataDir = path.resolve(dataDirEnv);
  if (workspace === path.parse(workspace).root || dataDir === path.parse(dataDir).root) {
    throw new Error("AIMESSENGER_WORKING_DIR and AIMESSENGER_DATA_DIR must not be filesystem roots.");
  }
  const releaseLock = acquireLock(dataDir);
  let handedOff = false;
  try {
    const paths = getReleasePaths(workspace);
    const source = paths.source;
    if (!fs.existsSync(path.join(source, ".git"))) throw new Error("Managed source checkout is missing .git.");

    run("git", ["diff", "--check"], source);
    run("git", ["diff", "--cached", "--check"], source);
    run("npm", ["test"], source);
    run("npm", ["run", "build"], source);

    const releaseId = newReleaseId();
    const releaseDir = path.join(paths.releases, releaseId);
    fs.mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
    copyRelease(source, releaseDir);
    writeReleaseMetadata(releaseDir, {
      id: releaseId,
      createdAt: new Date().toISOString(),
      sourceRevision: revision(source),
    });
    setSelfUpdateLockRelease(dataDir, releaseId);
    startReleaseWatchdog({
      workspaceRoot: workspace,
      dataDir,
      releaseId,
      port: Number(process.env.AIMESSENGER_PORT ?? "8787"),
      timeoutSeconds: Number(process.env.SELF_UPDATE_WATCHDOG_SECONDS ?? "90"),
    });
    const state = activateRelease({
      workspaceRoot: workspace,
      dataDir,
      releaseId,
      summary: argument("--summary"),
      checks: ["git diff --check", "npm test", "npm run build"],
      requestRestart: false,
    });
    writeRestartRequest(dataDir, { releaseId, requestedAt: new Date().toISOString() });
    handedOff = true;
    console.log(
      JSON.stringify({
        releaseId,
        previousReleaseId: state.previousReleaseId ?? null,
        phase: state.phase,
      }),
    );
  } finally {
    releaseLock(!handedOff);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
