import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppLogger } from "./logger.js";

const RELEASE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const STATE_FILE = "self-update.json";
const RESTART_FILE = "self-update-restart";
const LOCK_FILE = "self-update.lock";

export type SelfUpdatePhase = "pending" | "starting" | "healthy" | "rolled_back" | "failed";

export interface ReleaseMetadata {
  id: string;
  createdAt: string;
  sourceRevision?: string;
}

export interface SelfUpdateState {
  version: 1;
  phase: SelfUpdatePhase;
  currentReleaseId: string;
  previousReleaseId?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  checks?: string[];
  error?: string;
}

export interface RestartRequest {
  releaseId: string;
  requestedAt: string;
}

export interface ReleasePaths {
  root: string;
  source: string;
  releases: string;
  current: string;
  previous: string;
}

export function getReleasePaths(workspaceRoot: string): ReleasePaths {
  const root = path.resolve(workspaceRoot);
  return {
    root,
    source: path.join(root, "source"),
    releases: path.join(root, "releases"),
    current: path.join(root, "current"),
    previous: path.join(root, "previous"),
  };
}

export function readReleaseMetadata(appRoot: string): ReleaseMetadata {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(appRoot, "release.json"), "utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error("invalid release metadata");
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || !RELEASE_ID.test(record.id)) throw new Error("invalid release ID");
    return {
      id: record.id,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "unknown",
      ...(typeof record.sourceRevision === "string" ? { sourceRevision: record.sourceRevision } : {}),
    };
  } catch {
    return { id: "legacy", createdAt: "unknown" };
  }
}

export function writeReleaseMetadata(releaseDir: string, metadata: ReleaseMetadata): void {
  validateReleaseId(metadata.id);
  writeJson(path.join(releaseDir, "release.json"), metadata, 0o600);
}

export function readSelfUpdateState(dataDir: string): SelfUpdateState | undefined {
  const state = readJson<SelfUpdateState>(path.join(dataDir, STATE_FILE));
  if (
    !state ||
    state.version !== 1 ||
    !isReleaseId(state.currentReleaseId) ||
    !isPhase(state.phase) ||
    typeof state.createdAt !== "string" ||
    typeof state.updatedAt !== "string" ||
    (state.previousReleaseId !== undefined && !isReleaseId(state.previousReleaseId))
  ) {
    return undefined;
  }
  return state;
}

export function writeSelfUpdateState(dataDir: string, state: SelfUpdateState): void {
  validateReleaseId(state.currentReleaseId);
  if (state.previousReleaseId) validateReleaseId(state.previousReleaseId);
  writeJson(path.join(dataDir, STATE_FILE), state, 0o600);
}

export function writeRestartRequest(dataDir: string, request: RestartRequest): void {
  validateReleaseId(request.releaseId);
  writeJson(path.join(dataDir, RESTART_FILE), request, 0o600);
}

export function readRestartRequest(dataDir: string): RestartRequest | undefined {
  const request = readJson<RestartRequest>(path.join(dataDir, RESTART_FILE));
  if (!request || !RELEASE_ID.test(request.releaseId) || typeof request.requestedAt !== "string") {
    return undefined;
  }
  return request;
}

export function clearRestartRequest(dataDir: string): void {
  fs.rmSync(path.join(dataDir, RESTART_FILE), { force: true });
}

export function setSelfUpdateLockRelease(dataDir: string, releaseId: string): void {
  validateReleaseId(releaseId);
  writeJson(path.join(dataDir, LOCK_FILE), { releaseId }, 0o600);
}

export function clearSelfUpdateLock(dataDir: string, releaseId: string): void {
  const lock = readJson<{ releaseId?: unknown }>(path.join(dataDir, LOCK_FILE));
  if (lock?.releaseId === releaseId) fs.rmSync(path.join(dataDir, LOCK_FILE), { force: true });
}

export function activateRelease(input: {
  workspaceRoot: string;
  dataDir: string;
  releaseId: string;
  summary?: string;
  checks: string[];
  requestRestart?: boolean;
}): SelfUpdateState {
  validateReleaseId(input.releaseId);
  const paths = getReleasePaths(input.workspaceRoot);
  const candidate = releaseDirectory(paths, input.releaseId);
  if (!fs.statSync(candidate).isDirectory()) throw new Error(`Release directory is missing: ${candidate}`);
  if (readReleaseMetadata(candidate).id !== input.releaseId) {
    throw new Error(`Release metadata does not match ${input.releaseId}.`);
  }
  const previousReleaseId = linkedReleaseId(paths.current);
  if (previousReleaseId) replaceSymlink(paths.previous, path.join("releases", previousReleaseId));
  replaceSymlink(paths.current, path.join("releases", input.releaseId));
  const now = new Date().toISOString();
  const state: SelfUpdateState = {
    version: 1,
    phase: "pending",
    currentReleaseId: input.releaseId,
    ...(previousReleaseId ? { previousReleaseId } : {}),
    createdAt: now,
    updatedAt: now,
    ...(input.summary ? { summary: input.summary.slice(0, 1_000) } : {}),
    checks: input.checks,
  };
  writeSelfUpdateState(input.dataDir, state);
  if (input.requestRestart !== false) {
    writeRestartRequest(input.dataDir, { releaseId: input.releaseId, requestedAt: now });
  }
  return state;
}

export function rollbackRelease(
  workspaceRoot: string,
  dataDir: string,
  options: { requestRestart?: boolean } = {},
): SelfUpdateState {
  const paths = getReleasePaths(workspaceRoot);
  const currentReleaseId = linkedReleaseId(paths.current);
  const previousReleaseId = linkedReleaseId(paths.previous);
  if (!currentReleaseId || !previousReleaseId) throw new Error("No previous healthy release is available.");
  replaceSymlink(paths.current, path.join("releases", previousReleaseId));
  replaceSymlink(paths.previous, path.join("releases", currentReleaseId));
  const now = new Date().toISOString();
  const state: SelfUpdateState = {
    version: 1,
    phase: "pending",
    currentReleaseId: previousReleaseId,
    previousReleaseId: currentReleaseId,
    createdAt: now,
    updatedAt: now,
    summary: "Manual rollback requested.",
    checks: ["previous healthy release"],
  };
  writeSelfUpdateState(dataDir, state);
  if (options.requestRestart !== false) {
    writeRestartRequest(dataDir, { releaseId: previousReleaseId, requestedAt: now });
  }
  return state;
}

export function startReleaseWatchdog(input: {
  workspaceRoot: string;
  dataDir: string;
  releaseId: string;
  port: number;
  timeoutSeconds: number;
}): void {
  validateReleaseId(input.releaseId);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("Invalid watchdog port.");
  }
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 15 || input.timeoutSeconds > 300) {
    throw new Error("Invalid watchdog timeout.");
  }
  const releaseDir = releaseDirectory(getReleasePaths(input.workspaceRoot), input.releaseId);
  if (readReleaseMetadata(releaseDir).id !== input.releaseId) {
    throw new Error(`Release metadata does not match ${input.releaseId}.`);
  }
  const watchdog = path.join(releaseDir, "dist", "src", "self-update-watchdog.js");
  if (!fs.existsSync(watchdog)) throw new Error("Release is missing the self-update watchdog.");
  const child = spawn(
    process.execPath,
    [
      watchdog,
      "--workspace",
      input.workspaceRoot,
      "--data-dir",
      input.dataDir,
      "--port",
      String(input.port),
      "--release-id",
      input.releaseId,
      "--timeout-seconds",
      String(input.timeoutSeconds),
    ],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
}

export function markReleasePhase(
  dataDir: string,
  releaseId: string,
  phase: SelfUpdatePhase,
  error?: string,
): SelfUpdateState | undefined {
  const current = readSelfUpdateState(dataDir);
  if (!current || current.currentReleaseId !== releaseId) return undefined;
  const next: SelfUpdateState = {
    ...current,
    phase,
    updatedAt: new Date().toISOString(),
    ...(error ? { error: error.slice(0, 1_000) } : {}),
  };
  writeSelfUpdateState(dataDir, next);
  return next;
}

export function formatSelfUpdateStatus(
  release: ReleaseMetadata,
  state: SelfUpdateState | undefined,
): string {
  if (!state) return `Release: ${release.id}\nSelf-update: no recorded updates`;
  return [
    `Release: ${release.id}`,
    `Self-update: ${state.phase}`,
    `Previous release: ${state.previousReleaseId ?? "none"}`,
    `Last update: ${state.updatedAt}`,
    ...(state.error ? [`Update error: ${state.error}`] : []),
  ].join("\n");
}

export class SelfUpdateMonitor {
  private timer?: NodeJS.Timeout;
  private handling = false;

  constructor(
    private readonly dataDir: string,
    private readonly releaseId: string,
    private readonly logger: AppLogger,
    private readonly onRestart: () => Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkNow(), 1_000);
    this.timer.unref();
    void this.checkNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkNow(): Promise<void> {
    if (this.handling) return;
    const request = readRestartRequest(this.dataDir);
    if (!request) return;
    if (request.releaseId === this.releaseId) {
      const state = readSelfUpdateState(this.dataDir);
      if (state?.phase === "pending") markReleasePhase(this.dataDir, this.releaseId, "starting");
      clearRestartRequest(this.dataDir);
      this.logger.info("self_update.release_started", { release_id: this.releaseId });
      return;
    }
    this.handling = true;
    this.logger.info("self_update.restart_requested", {
      current_release_id: this.releaseId,
      target_release_id: request.releaseId,
    });
    try {
      await this.onRestart();
    } finally {
      this.handling = false;
    }
  }
}

export function newReleaseId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `iris-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function linkedReleaseId(linkPath: string): string | undefined {
  try {
    const target = fs.readlinkSync(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), target);
    const releases = path.join(path.dirname(linkPath), "releases");
    if (!resolved.startsWith(`${releases}${path.sep}`)) return undefined;
    const metadata = readReleaseMetadata(resolved);
    return metadata.id === path.basename(resolved) ? metadata.id : undefined;
  } catch {
    return undefined;
  }
}

function releaseDirectory(paths: ReleasePaths, releaseId: string): string {
  const candidate = path.resolve(paths.releases, releaseId);
  if (!candidate.startsWith(`${paths.releases}${path.sep}`)) throw new Error("Invalid release path.");
  return candidate;
}

function replaceSymlink(linkPath: string, target: string): void {
  const temporary = path.join(
    path.dirname(linkPath),
    `.${path.basename(linkPath)}-${crypto.randomBytes(6).toString("hex")}`,
  );
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, linkPath);
}

function writeJson(filePath: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function validateReleaseId(releaseId: string): void {
  if (!isReleaseId(releaseId)) throw new Error(`Invalid release ID: ${releaseId}`);
}

function isReleaseId(value: unknown): value is string {
  return typeof value === "string" && RELEASE_ID.test(value);
}

function isPhase(value: unknown): value is SelfUpdatePhase {
  return (
    value === "pending" ||
    value === "starting" ||
    value === "healthy" ||
    value === "rolled_back" ||
    value === "failed"
  );
}
