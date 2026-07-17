import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import { TelegramAgentService } from "../src/service.js";
import type { TelegramClient, TelegramUpdate } from "../src/telegram.js";
import type { JobWorker } from "../src/worker.js";

const tempDirs: string[] = [];

function fixture() {
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
    stopCurrent: vi.fn(() => 44),
  } as unknown as JobWorker;
  const config = {
    TELEGRAM_ALLOWED_USER_ID: 123,
    DEFAULT_PROVIDER: "codex",
  } as Config;
  const service = new TelegramAgentService(db, telegram, worker, config);
  return { db, telegram, worker, config, service, sent };
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
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TelegramAgentService", () => {
  it("rejects unauthorized users and deduplicates authorized replay", async () => {
    const { service, db, worker, sent } = fixture();
    await handle(service, update(1, "ignored", 999));
    expect(db.status().queued).toBe(0);
    expect(sent).toEqual([]);

    const authorized = update(2, "do the work");
    await handle(service, authorized);
    await handle(service, authorized);
    expect(db.status().queued).toBe(1);
    expect(worker.notify).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
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
    expect(sent.filter((text) => text.includes("Queued retry"))).toHaveLength(1);

    await handle(service, update(12, "/stop"));
    expect(worker.stopCurrent).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toContain("Stopping job #44");
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
      usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
    });

    await handle(service, update(16, "/cost"));
    expect(sent.at(-1)).toContain("Today: $0.0125 reported across 2 runs; 1 without a dollar figure");
    expect(sent.at(-1)).toContain("Codex tokens (All time; Codex does not return a dollar amount): 100 input, 25 cached input, 50 output");
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
});
