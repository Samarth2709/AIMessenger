import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerEvent } from "../src/codex-app-server.js";
import type { Config } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import { LiveCodexConversationManager } from "../src/live-conversations.js";
import type { AppLogger } from "../src/logger.js";
import type { TelegramClient } from "../src/telegram.js";

const tempDirs: string[] = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-live-"));
  tempDirs.push(dir);
  const db = new AppDatabase(path.join(dir, "test.sqlite"));
  const sent: Array<{ chatId: number; text: string; jobId?: number }> = [];
  const telegram = {
    sendText: vi.fn(async (chatId: number, text: string, jobId?: number) => {
      sent.push({ chatId, text, jobId });
      return [sent.length];
    }),
    sendTyping: vi.fn(async () => undefined),
  } as unknown as TelegramClient;
  const config = {
    AIMESSENGER_WORKING_DIR: dir,
    jobsDir: path.join(dir, "jobs"),
    JOB_TIMEOUT_MINUTES: 1,
    CODEX_COMMAND: "codex",
    appRoot: dir,
    identityPath: path.join(dir, "IDENTITY.md"),
    skillsDir: path.join(dir, "skills"),
  } as Config;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies AppLogger;
  const notifyDelivery = vi.fn();
  const manager = new LiveCodexConversationManager(db, telegram, config, logger, notifyDelivery);
  return { db, manager, notifyDelivery, sent };
}

function createRunningTurn(db: AppDatabase, manager: LiveCodexConversationManager) {
  const chatId = 123;
  const queued = db.enqueueLiveCodexMessage({
    updateId: 1,
    telegramMessageId: 10,
    chatId,
    userId: 123,
    prompt: "Inspect this project.",
    body: "Inspect this project.",
    model: "gpt-5.6-terra",
  });
  const jobId = queued.jobId!;
  expect(db.setLiveConversationTurn(chatId, jobId, "thread-1", "turn-1")).toBe(true);
  (manager as unknown as { runningChats: Set<number> }).runningChats.add(chatId);
  return { chatId, jobId };
}

function emit(manager: LiveCodexConversationManager, event: CodexAppServerEvent): void {
  (manager as unknown as { onServerEvent(event: CodexAppServerEvent): void }).onServerEvent(event);
}

function agentMessage(text: string): CodexAppServerEvent {
  return {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", text },
    },
  };
}

function tokenUsage(): CodexAppServerEvent {
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
      },
    },
  };
}

function completed(finalMessage: string): CodexAppServerEvent {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", text: finalMessage }],
      },
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("LiveCodexConversationManager", () => {
  it("sends Codex's first progress message before its completed result", async () => {
    vi.useFakeTimers();
    const { db, manager, notifyDelivery, sent } = fixture();
    await manager.start();
    const { chatId, jobId } = createRunningTurn(db, manager);

    emit(
      manager,
      agentMessage('{"message":"I’ll inspect the workspace, then make the targeted change.","attachments":[]}'),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(sent).toEqual([
      { chatId, jobId, text: "I’ll inspect the workspace, then make the targeted change." },
    ]);

    emit(manager, tokenUsage());
    emit(manager, completed('{"message":"Implemented and verified the change.","attachments":[]}'));
    await flush();

    expect(db.getJob(jobId)?.status).toBe("completed");
    expect(db.getJob(jobId)).toMatchObject({
      input_tokens: 100,
      cached_input_tokens: 25,
      output_tokens: 50,
      model: "gpt-5.6-terra",
      cost_credits: 0.02359375,
    });
    expect(notifyDelivery).toHaveBeenCalledOnce();
    const final = db.claimNextOutbox()!;
    expect(JSON.parse(final.payload_json)).toEqual({ text: "Implemented and verified the change." });
    await manager.shutdown();
    db.close();
  });

  it("does not duplicate a final-only agent message", async () => {
    vi.useFakeTimers();
    const { db, manager, sent } = fixture();
    await manager.start();
    const { jobId } = createRunningTurn(db, manager);
    const final = '{"message":"The concise final answer.","attachments":[]}';

    emit(manager, agentMessage(final));
    emit(manager, completed(final));
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(sent).toEqual([]);
    expect(db.getJob(jobId)?.status).toBe("completed");
    expect(JSON.parse(db.claimNextOutbox()!.payload_json)).toEqual({ text: "The concise final answer." });
    await manager.shutdown();
    db.close();
  });
});
