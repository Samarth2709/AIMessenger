import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import type { AgentProvider } from "../src/providers/types.js";
import { TelegramClient } from "../src/telegram.js";
import { JobWorker } from "../src/worker.js";

const tempDirs: string[] = [];

function json(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("JobWorker", () => {
  it("runs a queued provider job and persists the completed session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-worker-"));
    tempDirs.push(dir);
    const db = new AppDatabase(path.join(dir, "test.sqlite"));
    db.recordUpdate(1, 2, 3, 4, "hello");
    const jobId = db.enqueueJob({
      updateId: 1,
      telegramMessageId: 2,
      chatId: 3,
      provider: "codex",
      prompt: "hello",
      attachments: [],
    });

    let nextMessageId = 100;
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sendChatAction")) return json(true);
      if (url.endsWith("/sendMessage")) {
        return json({ message_id: nextMessageId++, chat: { id: 3, type: "private" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const telegram = new TelegramClient("test-token-that-is-long-enough", "https://example.test", fakeFetch);
    const provider: AgentProvider = {
      run: vi.fn(async () => ({
        result: { message: "finished", attachments: [] },
        sessionId: "session-1",
        rawOutput: "",
        metrics: { costUsd: 0.0125 },
      })),
    };
    const config = {
      AIMESSENGER_DATA_DIR: dir,
      AIMESSENGER_WORKING_DIR: dir,
      JOB_TIMEOUT_MINUTES: 1,
      jobsDir: path.join(dir, "jobs"),
      appRoot: path.resolve("."),
    } as Config;
    const worker = new JobWorker(
      db,
      telegram,
      { codex: provider, claude: provider },
      config,
    );
    worker.start();

    await vi.waitFor(() => {
      expect(db.getJob(jobId)?.status).toBe("completed");
      expect(db.pendingOutboxCount()).toBe(0);
    });
    expect(db.getProviderSession("codex").session_id).toBe("session-1");
    expect(db.costSummary().costUsd).toBe(0.0125);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://example.test/bottest-token-that-is-long-enough/sendMessage",
      expect.any(Object),
    );
    await worker.shutdown();
    db.close();
  });

  it("kills a persisted orphan process group before marking its job interrupted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-orphan-"));
    tempDirs.push(dir);
    const db = new AppDatabase(path.join(dir, "test.sqlite"));
    db.recordUpdate(31, 32, 33, 34, "orphan");
    const jobId = db.enqueueJob({
      updateId: 31,
      telegramMessageId: 32,
      chatId: 33,
      provider: "codex",
      prompt: "orphan",
      attachments: [],
    });
    db.claimNextJob();

    const sleeper = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = sleeper.pid!;
    db.setJobProcessPid(jobId, pid);
    const exited = new Promise<void>((resolve) => sleeper.once("close", () => resolve()));

    const telegram = {} as TelegramClient;
    const provider: AgentProvider = {
      run: vi.fn(async () => ({
        result: { message: "unused", attachments: [] },
        sessionId: null,
        rawOutput: "",
      })),
    };
    const config = {
      AIMESSENGER_DATA_DIR: dir,
      AIMESSENGER_WORKING_DIR: dir,
      JOB_TIMEOUT_MINUTES: 1,
      jobsDir: path.join(dir, "jobs"),
      appRoot: path.resolve("."),
    } as Config;
    const worker = new JobWorker(db, telegram, { codex: provider, claude: provider }, config);
    worker.start();
    await exited;
    expect(db.getJob(jobId)?.status).toBe("interrupted");
    expect(() => process.kill(-pid, 0)).toThrow();
    await worker.shutdown();
    db.close();
  });
});
