import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import { codexCreditsForUsage } from "../src/pricing.js";
import type { AppLogger } from "../src/logger.js";
import type { LiveCodexConversations } from "../src/live-conversations.js";
import type { ModelCatalog } from "../src/models.js";
import { TelegramAgentService } from "../src/service.js";
import type { TelegramClient, TelegramUpdate } from "../src/telegram.js";
import type { JobWorker } from "../src/worker.js";

const tempDirs: string[] = [];

function fixture(liveCodex?: LiveCodexConversations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-service-"));
  tempDirs.push(dir);
  const db = new AppDatabase(path.join(dir, "test.sqlite"));
  const sent: string[] = [];
  const telegram = {
    initialize: vi.fn(async () => ({ id: 1, username: "testbot" })),
    getUpdates: vi.fn(),
    sendText: vi.fn(async (_chatId: number, text: string) => {
      sent.push(text);
      return [sent.length];
    }),
  } as unknown as TelegramClient;
  const worker = {
    start: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    notify: vi.fn(),
    pause: vi.fn(),
    getCurrentJobId: vi.fn(() => undefined),
    stopCurrent: vi.fn(() => 44),
  } as unknown as JobWorker;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies AppLogger;
  const config = {
    TELEGRAM_ALLOWED_USER_ID: 123,
    DEFAULT_PROVIDER: "codex",
    CODEX_MODEL: "test-model",
    AIMESSENGER_DATA_DIR: dir,
    AIMESSENGER_WORKING_DIR: path.join(dir, "workspace"),
    AIMESSENGER_PORT: 8787,
    SELF_UPDATE_ENABLED: true,
    SELF_UPDATE_WATCHDOG_SECONDS: 90,
    appRoot: dir,
    skillsDir: path.join(dir, "skills"),
  } as Config;
  const modelCatalog: ModelCatalog = {
    list: vi.fn(async () => [
      { id: "model-one", name: "Model One", description: "" },
      { id: "model-two", name: "Model Two", description: "" },
    ]),
  };
  const service = new TelegramAgentService(db, telegram, worker, config, logger, modelCatalog, liveCodex);
  return { db, telegram, worker, config, logger, modelCatalog, service, sent };
}

function update(updateId: number, text: string, userId = 123): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: "private" },
      text,
    },
  };
}

async function handle(service: TelegramAgentService, value: TelegramUpdate): Promise<void> {
  await (
    service as unknown as { handleUpdate(update: TelegramUpdate): Promise<void> }
  ).handleUpdate(value);
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TelegramAgentService", () => {
  it("rejects unauthorized users and deduplicates authorized replay", async () => {
    const { service, db, worker, logger, sent } = fixture();
    await handle(service, update(1, "ignored", 999));
    expect(db.status().queued).toBe(0);
    expect(sent).toEqual([]);

    const authorized = update(2, "do the work");
    await handle(service, authorized);
    await handle(service, authorized);
    expect(db.status().queued).toBe(1);
    expect(worker.notify).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "job.queued",
      expect.objectContaining({ attachment_count: 0, provider: "codex", text_length: 11 }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("do the work");
    db.close();
  });

  it("routes stop and atomically creates retry jobs", async () => {
    const { service, db, worker, sent } = fixture();
    await handle(service, update(10, "original"));
    const original = db.claimNextJob()!;
    db.failJob(original.id, "canceled", "test stop");

    await handle(service, update(11, `/retry ${original.id}`));
    await handle(service, update(11, `/retry ${original.id}`));
    expect(db.status().queued).toBe(1);
    expect(sent.filter((text) => text === "Retry queued.")).toHaveLength(1);

    await handle(service, update(12, "/stop"));
    expect(worker.stopCurrent).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toContain("Stopping job #44");
    db.close();
  });

  it("shows the latest retryable job only through status", async () => {
    const { service, db, sent } = fixture();
    await handle(service, update(15, "will fail"));
    const job = db.claimNextJob()!;
    db.failJob(job.id, "failed", "test failure");

    await handle(service, update(16, "/status"));

    expect(sent.at(-1)).toContain(`Latest retryable: job #${job.id} (failed)`);
    expect(sent.at(-1)).toContain("Model: test-model");
    db.close();
  });

  it("reports self-update status without exposing internal release files", async () => {
    const { service, db, sent } = fixture();

    await handle(service, update(16, "/updates"));

    expect(sent.at(-1)).toContain("Release: legacy");
    expect(sent.at(-1)).toContain("Self-update: no recorded updates");
    db.close();
  });

  it("stops polling and pauses new jobs before a self-update restart", async () => {
    const { service, db, worker } = fixture();

    await expect(service.prepareForSelfUpdate(10)).resolves.toBe(true);

    expect(worker.pause).toHaveBeenCalledOnce();
    db.close();
  });

  it("lists provider-neutral skills", async () => {
    const { service, db, config, sent } = fixture();
    fs.mkdirSync(path.join(config.skillsDir, "research"), { recursive: true });
    fs.writeFileSync(
      path.join(config.skillsDir, "research", "SKILL.md"),
      "---\nname: research\ndescription: Research current facts.\n---\n",
    );

    await handle(service, update(17, "/skills"));

    expect(sent.at(-1)).toContain("research: Research current facts.");
    db.close();
  });

  it("lists and selects a model from a bare numeric reply while resetting the provider session", async () => {
    const { service, db, sent } = fixture();
    await handle(service, update(18, "/model"));
    expect(sent.at(-1)).toContain("1. **Model One**");
    expect(sent.at(-1)).toContain("Reply with a number");

    await handle(service, update(19, "2"));
    expect(db.getSelectedModel("codex")).toBe("model-two");
    expect(db.getProviderSession("codex").session_id).toBeNull();
    expect(sent.at(-1)).toContain("model-two");
    db.close();
  });

  it("treats a non-numeric reply after a model list as a normal prompt", async () => {
    const { service, db, worker } = fixture();
    await handle(service, update(18, "/model"));
    await handle(service, update(19, "2 explain the difference"));

    expect(db.getSelectedModel("codex")).toBeUndefined();
    expect(db.status().queued).toBe(1);
    expect(worker.notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("sends ordinary Codex text to the live conversation manager", async () => {
    const liveCodex = {
      start: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      accept: vi.fn(async () => true),
      status: vi.fn(() => ({ active: false })),
      stop: vi.fn(async () => false),
      reset: vi.fn(async () => undefined),
    } satisfies LiveCodexConversations;
    const { service, db, config, worker } = fixture(liveCodex);
    config.CODEX_LIVE_CONVERSATIONS = true;

    await handle(service, update(21, "work on this live"));

    expect(liveCodex.accept).toHaveBeenCalledWith(
      expect.objectContaining({ body: "work on this live", model: "test-model" }),
    );
    expect(db.status().queued).toBe(0);
    expect(worker.notify).not.toHaveBeenCalled();
    db.close();
  });

  it("labels selected AI Security models in the picker and status", async () => {
    const { service, db, config, modelCatalog, sent } = fixture();
    config.GATEWAY_MODELS = "model-two";
    vi.mocked(modelCatalog.list).mockResolvedValue([
      { id: "model-one", name: "Model One", description: "" },
      { id: "model-two", name: "Model Two", description: "", source: "AI Security" },
    ]);

    await handle(service, update(18, "/model"));
    expect(sent.at(-1)).toContain("model-two`) - AI Security");
    await handle(service, update(19, "2"));
    await handle(service, update(20, "/status"));

    expect(db.getSelectedModel("codex")).toBe("model-two");
    expect(sent.at(-1)).toContain("Runtime: AI Security gateway");
    db.close();
  });

  it("reports provider cost and Codex token usage", async () => {
    const { service, db, sent } = fixture();
    db.recordUpdate(14, 140, 123, 123, "costed Claude work");
    const claude = db.enqueueJob({
      updateId: 14,
      telegramMessageId: 140,
      chatId: 123,
      provider: "claude",
      prompt: "costed Claude work",
      attachments: [],
    });
    db.completeJob(claude, "done", "claude", "claude-session", [], { costUsd: 0.0125 });

    db.recordUpdate(15, 150, 123, 123, "metered Codex work");
    const codex = db.enqueueJob({
      updateId: 15,
      telegramMessageId: 150,
      chatId: 123,
      provider: "codex",
      prompt: "metered Codex work",
      attachments: [],
    });
    db.completeJob(codex, "done", "codex", "codex-session", [], {
      model: "gpt-5.6-terra",
      codexCredits: codexCreditsForUsage("gpt-5.6-terra", {
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 50,
      }),
      usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
    });

    await handle(service, update(16, "/cost"));
    expect(sent.at(-1)).toContain("Today: 0.023594 Codex credits; $0.0125 provider-reported USD across 2 runs");
    expect(sent.at(-1)).toContain("Codex and gateway usage (All time): 100 input, 25 cached input, 50 output");
    db.close();
  });

  it("advances the persisted long-poll offset after handling an update", async () => {
    const { service, db, telegram } = fixture();
    let call = 0;
    vi.mocked(telegram.getUpdates).mockImplementation(async (_offset, signal) => {
      call += 1;
      if (call === 1) return [update(20, "/status")];
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    });
    await service.start();
    await vi.waitFor(() => expect(db.getSetting("telegram_offset")).toBe("21"));
    await service.shutdown();
    expect(telegram.getUpdates).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    db.close();
  });

  it("retries Telegram initialization without restarting the service", async () => {
    vi.useFakeTimers();
    const { service, db, telegram, worker, logger } = fixture();
    vi.mocked(telegram.initialize)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: 1, username: "testbot" });
    vi.mocked(telegram.getUpdates).mockImplementation(
      async (_offset, signal) =>
        new Promise((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true })),
    );

    const started = service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await started;

    expect(telegram.initialize).toHaveBeenCalledTimes(2);
    expect(worker.start).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("telegram.initialize_failed", expect.any(TypeError));
    await service.shutdown();
    db.close();
  });
});
