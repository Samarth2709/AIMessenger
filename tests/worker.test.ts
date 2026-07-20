import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import type { AppLogger } from "../src/logger.js";
import type { AgentProvider, ProviderRunOutput } from "../src/providers/types.js";
import { TelegramClient } from "../src/telegram.js";
import { JobWorker } from "../src/worker.js";

const tempDirs: string[] = [];

function createLogger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
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
        result: { message: "finished", attachments: [], sessionDisposition: "continue" as const, memoryRefs: [] },
        sessionId: "session-1",
        rawOutput: "",
        metrics: {
          costUsd: 0.0125,
          usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
        },
      })),
    };
    const config = {
      AIMESSENGER_DATA_DIR: dir,
      AIMESSENGER_WORKING_DIR: dir,
      JOB_TIMEOUT_MINUTES: 1,
      CODEX_MODEL: "gpt-5.6-terra",
      jobsDir: path.join(dir, "jobs"),
      appRoot: path.resolve("."),
      identityPath: path.resolve("IDENTITY.md"),
      skillsDir: path.resolve("skills"),
    } as Config;
    const logger = createLogger();
    const worker = new JobWorker(
      db,
      telegram,
      { codex: provider, claude: provider },
      config,
      logger,
    );
    worker.start();

    await vi.waitFor(() => {
      expect(db.getJob(jobId)?.status).toBe("completed");
      expect(db.pendingOutboxCount()).toBe(0);
    });
    expect(db.getProviderSession("codex").session_id).toBe("session-1");
    expect(db.costSummary().costUsd).toBe(0.0125);
    expect(db.getJob(jobId)).toMatchObject({
      model: "gpt-5.6-terra",
      cost_credits: 0.02359375,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "job.completed",
      expect.objectContaining({ job_id: jobId, result_length: 8 }),
    );
    expect(logger.info).toHaveBeenCalledWith("telegram.typing_sent", { phase: "initial" });
    expect(vi.mocked(provider.run).mock.calls[0]?.[0].identity).toContain("You are Iris");
    expect(vi.mocked(provider.run).mock.calls[0]?.[0].skills.map((skill) => skill.name)).toContain(
      "research",
    );
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://example.test/bottest-token-that-is-long-enough/sendMessage",
      expect.any(Object),
    );

    db.recordUpdate(2, 3, 3, 4, "finish the task");
    const handoffJob = db.enqueueJob({
      updateId: 2,
      telegramMessageId: 3,
      chatId: 3,
      provider: "codex",
      prompt: "finish the task",
      attachments: [],
    });
    vi.mocked(provider.run).mockResolvedValueOnce({
      result: { message: "handed off", attachments: [], sessionDisposition: "handoff", memoryRefs: [] },
      sessionId: "session-2",
      rawOutput: "",
    });
    worker.notify();
    await vi.waitFor(() => expect(db.getJob(handoffJob)?.status).toBe("completed"));
    expect(db.getProviderSession("codex").session_id).toBeNull();
    await worker.shutdown();
    db.close();
  });

  it("clears an incompatible gateway model after a classified Codex fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-worker-fallback-"));
    tempDirs.push(dir);
    const db = new AppDatabase(path.join(dir, "test.sqlite"));
    db.recordUpdate(21, 22, 23, 24, "answer this");
    const jobId = db.enqueueJob({
      updateId: 21,
      telegramMessageId: 22,
      chatId: 23,
      provider: "codex",
      prompt: "answer this",
      attachments: [],
    });
    db.setSelectedModel("codex", "glm-5.2");
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sendChatAction")) return json(true);
      if (url.endsWith("/sendMessage")) return json({ message_id: 400, chat: { id: 23, type: "private" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const fakeFetch = fetchMock as unknown as typeof fetch;
    const provider: AgentProvider = {
      run: vi.fn(async () => ({
        result: { message: "continued with Codex", attachments: [] },
        sessionId: "fresh-codex-session",
        rawOutput: "",
        routing: {
          requestedModel: "glm-5.2",
          fallbackReason: "Gateway exceeded the memory tool-call round limit.",
        },
      })),
    };
    const logger = createLogger();
    const worker = new JobWorker(
      db,
      new TelegramClient("test-token-that-is-long-enough", "https://example.test", fakeFetch),
      { codex: provider, claude: provider },
      {
        AIMESSENGER_DATA_DIR: dir,
        AIMESSENGER_WORKING_DIR: dir,
        JOB_TIMEOUT_MINUTES: 1,
        CODEX_MODEL: "gpt-5.6-terra",
        GATEWAY_MODELS: "glm-5.2",
        jobsDir: path.join(dir, "jobs"),
        appRoot: path.resolve("."),
        identityPath: path.resolve("IDENTITY.md"),
        skillsDir: path.join(dir, "skills"),
      } as Config,
      logger,
    );
    worker.start();

    await vi.waitFor(() => expect(db.getJob(jobId)?.status).toBe("completed"));

    expect(db.getSelectedModel("codex")).toBeUndefined();
    expect(db.getJob(jobId)).toMatchObject({
      requested_model: "glm-5.2",
      fallback_reason: "Gateway exceeded the memory tool-call round limit.",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "gateway.capability_fallback",
      expect.objectContaining({ job_id: jobId, requested_model: "glm-5.2" }),
    );
    expect(fetchMock.mock.calls.some(([, init]) => String((init as RequestInit).body).includes("cleared that selection"))).toBe(true);
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
    const childSleeper = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = sleeper.pid!;
    const childPid = childSleeper.pid!;
    db.setJobProcessPid(jobId, pid);
    db.addJobProcess(jobId, childPid, "deep-research-track");
    const exited = Promise.all([
      new Promise<void>((resolve) => sleeper.once("close", () => resolve())),
      new Promise<void>((resolve) => childSleeper.once("close", () => resolve())),
    ]);

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
      identityPath: path.resolve("IDENTITY.md"),
      skillsDir: path.join(dir, "skills"),
    } as Config;
    const worker = new JobWorker(
      db,
      telegram,
      { codex: provider, claude: provider },
      config,
      createLogger(),
    );
    worker.start();
    await exited;
    expect(db.getJob(jobId)?.status).toBe("interrupted");
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(() => process.kill(-childPid, 0)).toThrow();
    expect(db.db.prepare("SELECT * FROM job_processes WHERE job_id = ?").all(jobId)).toEqual([]);
    await worker.shutdown();
    db.close();
  });

  it("refreshes the typing indicator while a provider job is active", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-typing-"));
    tempDirs.push(dir);
    const db = new AppDatabase(path.join(dir, "test.sqlite"));
    db.recordUpdate(41, 42, 43, 44, "long task");
    const jobId = db.enqueueJob({
      updateId: 41,
      telegramMessageId: 42,
      chatId: 43,
      provider: "codex",
      prompt: "long task",
      attachments: [],
    });
    let resolveProvider: ((value: ProviderRunOutput) => void) | undefined;
    const provider: AgentProvider = {
      run: vi.fn(
        () =>
          new Promise<ProviderRunOutput>((resolve) => {
            resolveProvider = resolve;
          }),
      ),
    };
    let typingCalls = 0;
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sendChatAction")) {
        typingCalls += 1;
        return json(true);
      }
      if (url.endsWith("/sendMessage")) {
        return json({ message_id: 200, chat: { id: 43, type: "private" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const telegram = new TelegramClient("test-token-that-is-long-enough", "https://example.test", fakeFetch);
    const config = {
      AIMESSENGER_DATA_DIR: dir,
      AIMESSENGER_WORKING_DIR: dir,
      JOB_TIMEOUT_MINUTES: 1,
      jobsDir: path.join(dir, "jobs"),
      appRoot: path.resolve("."),
      identityPath: path.resolve("IDENTITY.md"),
      skillsDir: path.join(dir, "skills"),
    } as Config;
    const worker = new JobWorker(
      db,
      telegram,
      { codex: provider, claude: provider },
      config,
      createLogger(),
    );
    worker.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(typingCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(typingCalls).toBe(2);

    resolveProvider?.({
      result: { message: "finished", attachments: [] },
      sessionId: "session-typing",
      rawOutput: "",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(db.getJob(jobId)?.status).toBe("completed");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(typingCalls).toBe(2);
    await worker.shutdown();
    db.close();
  });

  it("fails a blank agent result instead of completing with nothing to send", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-empty-result-"));
    tempDirs.push(dir);
    const db = new AppDatabase(path.join(dir, "test.sqlite"));
    db.recordUpdate(51, 52, 53, 54, "make an image");
    const jobId = db.enqueueJob({
      updateId: 51,
      telegramMessageId: 52,
      chatId: 53,
      provider: "codex",
      prompt: "make an image",
      attachments: [],
    });
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sendChatAction")) return json(true);
      if (url.endsWith("/sendMessage")) return json({ message_id: 300, chat: { id: 53, type: "private" } });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const provider: AgentProvider = {
      run: vi.fn(async () => ({
        result: { message: "", attachments: [] },
        sessionId: "empty-result",
        rawOutput: "",
      })),
    };
    const worker = new JobWorker(
      db,
      new TelegramClient("test-token-that-is-long-enough", "https://example.test", fakeFetch),
      { codex: provider, claude: provider },
      {
        AIMESSENGER_DATA_DIR: dir,
        AIMESSENGER_WORKING_DIR: dir,
        JOB_TIMEOUT_MINUTES: 1,
        jobsDir: path.join(dir, "jobs"),
        appRoot: path.resolve("."),
        identityPath: path.resolve("IDENTITY.md"),
        skillsDir: path.join(dir, "skills"),
      } as Config,
      createLogger(),
    );
    worker.start();

    await vi.waitFor(() => expect(db.getJob(jobId)?.status).toBe("failed"));
    expect(db.status().retryable?.id).toBe(jobId);
    expect(db.pendingOutboxCount()).toBe(0);
    await worker.shutdown();
    db.close();
  });
});
