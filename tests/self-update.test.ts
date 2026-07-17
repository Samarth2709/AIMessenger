import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppLogger } from "../src/logger.js";
import {
  activateRelease,
  formatSelfUpdateStatus,
  getReleasePaths,
  readRestartRequest,
  readSelfUpdateState,
  rollbackRelease,
  SelfUpdateMonitor,
  writeReleaseMetadata,
  writeRestartRequest,
  writeSelfUpdateState,
} from "../src/self-update.js";
import { isWatchdogEntrypoint, superviseRelease } from "../src/self-update-watchdog.js";

const tempDirs: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-update-"));
  tempDirs.push(root);
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const paths = getReleasePaths(workspace);
  fs.mkdirSync(paths.releases, { recursive: true });
  return { workspace, dataDir, paths };
}

function createRelease(releasesDir: string, id: string): void {
  const releaseDir = path.join(releasesDir, id);
  fs.mkdirSync(releaseDir, { recursive: true });
  writeReleaseMetadata(releaseDir, { id, createdAt: "2026-07-17T00:00:00.000Z" });
}

function linkRelease(linkPath: string, id: string): void {
  fs.symlinkSync(path.join("releases", id), linkPath);
}

function logger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("self-update releases", () => {
  it("atomically activates a validated release and records its restart request", () => {
    const { workspace, dataDir, paths } = fixture();
    createRelease(paths.releases, "iris-old");
    createRelease(paths.releases, "iris-new");
    linkRelease(paths.current, "iris-old");

    const state = activateRelease({
      workspaceRoot: workspace,
      dataDir,
      releaseId: "iris-new",
      summary: "Use a shorter response format.",
      checks: ["npm test", "npm run build"],
    });

    expect(fs.readlinkSync(paths.current)).toBe("releases/iris-new");
    expect(fs.readlinkSync(paths.previous)).toBe("releases/iris-old");
    expect(state).toMatchObject({ phase: "pending", currentReleaseId: "iris-new", previousReleaseId: "iris-old" });
    expect(readRestartRequest(dataDir)).toMatchObject({ releaseId: "iris-new" });
  });

  it("rolls back to the prior release and requests its restart", () => {
    const { workspace, dataDir, paths } = fixture();
    createRelease(paths.releases, "iris-old");
    createRelease(paths.releases, "iris-new");
    linkRelease(paths.current, "iris-new");
    linkRelease(paths.previous, "iris-old");

    const state = rollbackRelease(workspace, dataDir);

    expect(fs.readlinkSync(paths.current)).toBe("releases/iris-old");
    expect(fs.readlinkSync(paths.previous)).toBe("releases/iris-new");
    expect(state).toMatchObject({ phase: "pending", currentReleaseId: "iris-old", previousReleaseId: "iris-new" });
    expect(readRestartRequest(dataDir)).toMatchObject({ releaseId: "iris-old" });
  });

  it("shows concise release status", () => {
    expect(
      formatSelfUpdateStatus(
        { id: "iris-new", createdAt: "2026-07-17T00:00:00.000Z" },
        undefined,
      ),
    ).toBe("Release: iris-new\nSelf-update: no recorded updates");
  });
});

describe("self-update lifecycle", () => {
  it("recognizes a watchdog started through the current-release symlink", () => {
    const { paths } = fixture();
    const realEntry = path.join(paths.releases, "iris-new", "self-update-watchdog.js");
    fs.mkdirSync(path.dirname(realEntry), { recursive: true });
    fs.writeFileSync(realEntry, "");
    fs.symlinkSync(path.join("releases", "iris-new"), paths.current);

    expect(
      isWatchdogEntrypoint(
        pathToFileURL(realEntry).href,
        path.join(paths.current, "self-update-watchdog.js"),
      ),
    ).toBe(true);
  });

  it("asks the running release to drain when a different release is activated", async () => {
    const { dataDir } = fixture();
    writeRestartRequest(dataDir, { releaseId: "iris-new", requestedAt: "2026-07-17T00:00:00.000Z" });
    const restart = vi.fn(async () => undefined);
    const monitor = new SelfUpdateMonitor(dataDir, "iris-old", logger(), restart);

    await monitor.checkNow();

    expect(restart).toHaveBeenCalledOnce();
    expect(readRestartRequest(dataDir)).toMatchObject({ releaseId: "iris-new" });
  });

  it("lets the replacement release consume its own restart request", async () => {
    const { dataDir } = fixture();
    writeSelfUpdateState(dataDir, {
      version: 1,
      phase: "pending",
      currentReleaseId: "iris-new",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    writeRestartRequest(dataDir, { releaseId: "iris-new", requestedAt: "2026-07-17T00:00:00.000Z" });
    const restart = vi.fn(async () => undefined);
    const monitor = new SelfUpdateMonitor(dataDir, "iris-new", logger(), restart);

    await monitor.checkNow();

    expect(restart).not.toHaveBeenCalled();
    expect(readRestartRequest(dataDir)).toBeUndefined();
    expect(readSelfUpdateState(dataDir)?.phase).toBe("starting");
  });

  it("does not downgrade a release already accepted by its watchdog", async () => {
    const { dataDir } = fixture();
    writeSelfUpdateState(dataDir, {
      version: 1,
      phase: "healthy",
      currentReleaseId: "iris-new",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    writeRestartRequest(dataDir, { releaseId: "iris-new", requestedAt: "2026-07-17T00:00:00.000Z" });
    const monitor = new SelfUpdateMonitor(dataDir, "iris-new", logger(), vi.fn(async () => undefined));

    await monitor.checkNow();

    expect(readRestartRequest(dataDir)).toBeUndefined();
    expect(readSelfUpdateState(dataDir)?.phase).toBe("healthy");
  });

  it("marks a candidate healthy only when loopback health reports the matching release", async () => {
    const { workspace, dataDir, paths } = fixture();
    createRelease(paths.releases, "iris-old");
    createRelease(paths.releases, "iris-new");
    linkRelease(paths.current, "iris-new");
    linkRelease(paths.previous, "iris-old");
    writeSelfUpdateState(dataDir, {
      version: 1,
      phase: "starting",
      currentReleaseId: "iris-new",
      previousReleaseId: "iris-old",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, releaseId: "iris-new" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        superviseRelease({ workspace, dataDir, port, releaseId: "iris-new", timeoutSeconds: 15 }, 1),
      ).resolves.toBe("healthy");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    expect(readSelfUpdateState(dataDir)?.phase).toBe("healthy");
  });

  it("restores the previous release after a failed health check", async () => {
    const { workspace, dataDir, paths } = fixture();
    createRelease(paths.releases, "iris-old");
    createRelease(paths.releases, "iris-new");
    linkRelease(paths.current, "iris-new");
    linkRelease(paths.previous, "iris-old");
    writeSelfUpdateState(dataDir, {
      version: 1,
      phase: "starting",
      currentReleaseId: "iris-new",
      previousReleaseId: "iris-old",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });

    await expect(
      superviseRelease({ workspace, dataDir, port: 65_534, releaseId: "iris-new", timeoutSeconds: 0.01 }, 1),
    ).resolves.toBe("rolled_back");

    expect(fs.readlinkSync(paths.current)).toBe("releases/iris-old");
    expect(readSelfUpdateState(dataDir)).toMatchObject({
      phase: "rolled_back",
      currentReleaseId: "iris-old",
    });
  });
});
