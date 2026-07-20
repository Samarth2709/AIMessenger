import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db.js";
import { codexCreditsForUsage } from "../src/pricing.js";

const tempDirs: string[] = [];

function createDb(): AppDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-db-"));
  tempDirs.push(dir);
  return new AppDatabase(path.join(dir, "test.sqlite"));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AppDatabase", () => {
  it("adds model and credit fields to an existing jobs table", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-db-migration-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "test.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        user_message_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        retry_of INTEGER,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        result_text TEXT,
        process_pid INTEGER,
        cost_usd REAL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        usage_recorded_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacy.close();

    const db = new AppDatabase(databasePath);
    const columns = db.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["model", "cost_credits"]),
    );
    db.close();
  });

  it("migrates legacy user transcript rows into their originating chat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-db-transcript-migration-"));
    tempDirs.push(dir);
    const databasePath = path.join(dir, "test.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE transcript (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        provider TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        user_message_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        retry_of INTEGER,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        result_text TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO transcript(id, role, provider, content) VALUES (7, 'user', NULL, 'legacy context');
      INSERT INTO transcript(id, role, provider, content) VALUES (8, 'assistant', 'codex', 'legacy answer');
      INSERT INTO jobs(update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, status)
      VALUES (1, 2, 55, 7, 'codex', 'legacy context', 'completed');
    `);
    legacy.close();

    const db = new AppDatabase(databasePath);
    const transcriptColumns = db.db.prepare("PRAGMA table_info(transcript)").all() as Array<{ name: string }>;
    expect(transcriptColumns.map((column) => column.name)).toContain("chat_id");
    expect(db.searchHistory("legacy context", 55)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 7 })]),
    );
    expect(db.searchHistory("legacy context", 56)).toEqual([]);
    expect(db.searchHistory("legacy answer", 55)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 8, role: "assistant" })]),
    );
    db.close();
  });

  it("deduplicates Telegram updates and queues one job", () => {
    const db = createDb();
    expect(db.recordUpdate(10, 20, 30, 40, "hello")).toBe(true);
    expect(db.recordUpdate(10, 20, 30, 40, "hello")).toBe(false);
    const jobId = db.enqueueJob({
      updateId: 10,
      telegramMessageId: 20,
      chatId: 30,
      provider: "codex",
      prompt: "hello",
      attachments: [],
    });
    expect(db.getJob(jobId)?.status).toBe("queued");
    db.close();
  });

  it("clears an incompatible model selection and its provider session", () => {
    const db = createDb();
    db.setSelectedModel("codex", "gateway-model");
    db.clearSelectedModel("codex");

    expect(db.getSelectedModel("codex")).toBeUndefined();
    expect(db.getProviderSession("codex").session_id).toBeNull();
    db.close();
  });

  it("preserves deep-research mode when a failed job is retried", () => {
    const db = createDb();
    db.recordUpdate(11, 21, 31, 41, "Research this deeply");
    const original = db.enqueueJob({
      updateId: 11,
      telegramMessageId: 21,
      chatId: 31,
      provider: "codex",
      prompt: "Research this deeply",
      attachments: [],
      mode: "deep_research",
    });
    db.failJob(original, "failed", "three tracks did not complete");
    db.recordUpdate(12, 22, 31, 41, "/retry 1");

    const retry = db.retryJob(original, 12, 22);

    expect(db.getJob(retry!)!).toMatchObject({ retry_of: original, mode: "deep_research" });
    db.close();
  });

  it("marks running jobs interrupted instead of retrying them", () => {
    const db = createDb();
    db.recordUpdate(11, 21, 31, 41, "do work");
    const jobId = db.enqueueJob({
      updateId: 11,
      telegramMessageId: 21,
      chatId: 31,
      provider: "claude",
      prompt: "do work",
      attachments: [],
    });
    expect(db.claimNextJob()?.id).toBe(jobId);
    expect(db.recoverInterruptedJobs()).toBe(1);
    expect(db.getJob(jobId)?.status).toBe("interrupted");
    db.close();
  });

  it("keeps cross-provider transcript available only through explicit history retrieval", () => {
    const db = createDb();
    db.recordUpdate(12, 22, 32, 42, "first");
    const firstId = db.enqueueJob({
      updateId: 12,
      telegramMessageId: 22,
      chatId: 32,
      provider: "codex",
      prompt: "first",
      attachments: [],
    });
    db.completeJob(firstId, "codex answer", "codex", "codex-session");
    db.recordUpdate(13, 23, 32, 42, "second");
    const secondId = db.enqueueJob({
      updateId: 13,
      telegramMessageId: 23,
      chatId: 32,
      provider: "claude",
      prompt: "second",
      attachments: [],
    });
    expect(db.getJob(secondId)?.prompt).toBe("second");
    const match = db.searchHistory("codex answer", 32);
    expect(match).toHaveLength(1);
    expect(db.readHistory([match[0]!.id], 32)[0]?.content).toBe("codex answer");
    db.close();
  });

  it("atomically deduplicates update and job creation", () => {
    const db = createDb();
    const input = {
      updateId: 50,
      telegramMessageId: 60,
      chatId: 70,
      userId: 80,
      provider: "codex" as const,
      prompt: "atomic",
      body: "atomic",
      attachments: [],
    };
    const first = db.enqueueInboundJob(input);
    const second = db.enqueueInboundJob(input);
    expect(first.fresh).toBe(true);
    expect(second).toEqual({ fresh: false, jobId: first.jobId });
    expect(db.status().queued).toBe(1);
    db.close();
  });

  it("keeps one live Codex turn open and records later messages as steering", () => {
    const db = createDb();
    const first = db.enqueueLiveCodexMessage({
      updateId: 61,
      telegramMessageId: 71,
      chatId: 81,
      userId: 91,
      prompt: "first request",
      body: "first request",
      model: "gpt-test",
    });
    const second = db.enqueueLiveCodexMessage({
      updateId: 62,
      telegramMessageId: 72,
      chatId: 81,
      userId: 91,
      prompt: "actually focus on the tests",
      body: "actually focus on the tests",
      model: "gpt-test",
    });

    expect(first).toMatchObject({ fresh: true, action: "start" });
    expect(second).toEqual({ fresh: true, action: "steer" });
    expect(db.status().queued).toBe(0);
    expect(db.getJob(first.jobId!)?.status).toBe("running");
    expect(db.getLiveConversation(81)).toMatchObject({ state: "starting", active_job_id: first.jobId });
    expect(db.nextLiveSteer(81)?.prompt).toBe("actually focus on the tests");

    expect(db.setLiveConversationTurn(81, first.jobId!, "thread-1", "turn-1")).toBe(true);
    const steer = db.nextLiveSteer(81)!;
    db.markLiveSteerSent(steer.id);
    expect(db.nextLiveSteer(81)).toBeUndefined();
    db.close();
  });

  it("starts a follow-up turn when a message arrives after a live turn completes", () => {
    const db = createDb();
    const first = db.enqueueLiveCodexMessage({
      updateId: 63,
      telegramMessageId: 73,
      chatId: 83,
      userId: 93,
      prompt: "first request",
      body: "first request",
    });
    db.setLiveConversationTurn(83, first.jobId!, "thread-2", "turn-2");
    const late = db.enqueueLiveCodexMessage({
      updateId: 64,
      telegramMessageId: 74,
      chatId: 83,
      userId: 93,
      prompt: "one more thing",
      body: "one more thing",
    });
    expect(late.action).toBe("steer");

    db.completeJob(first.jobId!, "first result", "codex", "thread-2");
    db.finishLiveConversation(83, first.jobId!);
    const followup = db.startPendingLiveFollowup(83);

    expect(followup.jobId).toEqual(expect.any(Number));
    expect(db.getJob(followup.jobId!)?.prompt).toBe("one more thing");
    expect(db.getLiveConversation(83)).toMatchObject({
      state: "starting",
      active_job_id: followup.jobId,
      thread_id: "thread-2",
    });
    db.close();
  });

  it("taints a provider after a canceled run without replaying transcript context", () => {
    const db = createDb();
    db.recordUpdate(101, 201, 301, 401, "safe completed request");
    const completed = db.enqueueJob({
      updateId: 101,
      telegramMessageId: 201,
      chatId: 301,
      provider: "codex",
      prompt: "safe completed request",
      attachments: [],
    });
    db.completeJob(completed, "safe answer", "codex", "old-session");

    db.recordUpdate(102, 202, 301, 401, "dangerous stopped request");
    const stopped = db.enqueueJob({
      updateId: 102,
      telegramMessageId: 202,
      chatId: 301,
      provider: "codex",
      prompt: "dangerous stopped request",
      attachments: [],
    });
    db.claimNextJob();
    db.failJob(stopped, "canceled", "stopped");
    db.taintProvider("codex");

    db.recordUpdate(103, 203, 301, 401, "new request");
    db.enqueueJob({
      updateId: 103,
      telegramMessageId: 203,
      chatId: 301,
      provider: "codex",
      prompt: "new request",
      attachments: [],
    });
    expect(db.getProviderSession("codex")).toMatchObject({ session_id: null, tainted: 1 });
    db.close();
  });

  it("resets a native provider session without deleting transcript history", () => {
    const db = createDb();
    db.recordUpdate(111, 211, 311, 411, "old request");
    const old = db.enqueueJob({
      updateId: 111,
      telegramMessageId: 211,
      chatId: 311,
      provider: "claude",
      prompt: "old request",
      attachments: [],
    });
    db.completeJob(old, "old answer", "claude", "old-session");
    db.resetProvider("claude");
    db.recordUpdate(112, 212, 311, 411, "fresh request");
    db.enqueueJob({
      updateId: 112,
      telegramMessageId: 212,
      chatId: 311,
      provider: "claude",
      prompt: "fresh request",
      attachments: [],
    });
    expect(db.getProviderSession("claude")).toMatchObject({ session_id: null, tainted: 0 });
    expect(db.searchHistory("old answer", 311)).toHaveLength(1);
    db.close();
  });

  it("keeps stateless gateway transcript available through exact history search", () => {
    const db = createDb();
    db.recordUpdate(113, 213, 311, 411, "first gateway request");
    const first = db.enqueueJob({
      updateId: 113,
      telegramMessageId: 213,
      chatId: 311,
      provider: "codex",
      prompt: "first gateway request",
      attachments: [],
    });
    db.completeJob(first, "first gateway answer", "codex", "__aimessenger_stateless__");
    db.recordUpdate(114, 214, 311, 411, "second gateway request");
    db.enqueueJob({
      updateId: 114,
      telegramMessageId: 214,
      chatId: 311,
      provider: "codex",
      prompt: "second gateway request",
      attachments: [],
    });

    const match = db.searchHistory("first gateway answer", 311);
    expect(db.readHistory([match[0]!.id], 311)[0]?.content).toBe("first gateway answer");
    db.close();
  });

  it("recovers and retries durable outbound messages", () => {
    const db = createDb();
    db.recordUpdate(121, 221, 321, 421, "deliver");
    const job = db.enqueueJob({
      updateId: 121,
      telegramMessageId: 221,
      chatId: 321,
      provider: "codex",
      prompt: "deliver",
      attachments: [],
    });
    db.completeJob(job, "result", "codex", "session", [
      { chatId: 321, kind: "text", payload: { text: "part one" } },
      { chatId: 321, kind: "text", payload: { text: "part two" } },
    ]);
    const first = db.claimNextOutbox()!;
    db.retryOutbox(first.id, "temporary");
    expect(db.pendingOutboxCount()).toBe(2);
    expect(db.claimNextOutbox()).toBeUndefined();
    db.db.prepare("UPDATE outbox SET available_at = CURRENT_TIMESTAMP WHERE id = ?").run(first.id);
    const retried = db.claimNextOutbox()!;
    expect(retried.id).toBe(first.id);
    db.completeOutbox(retried.id, 999);
    const second = db.claimNextOutbox()!;
    expect(second.id).toBeGreaterThan(first.id);
    db.completeOutbox(second.id, 1000);
    expect(db.pendingOutboxCount()).toBe(0);
    db.close();
  });

  it("aggregates provider-reported costs and Codex token usage", () => {
    const db = createDb();
    db.recordUpdate(131, 231, 331, 431, "claude work");
    const claude = db.enqueueJob({
      updateId: 131,
      telegramMessageId: 231,
      chatId: 331,
      provider: "claude",
      prompt: "claude work",
      attachments: [],
    });
    db.completeJob(claude, "done", "claude", "claude-session", [], { costUsd: 0.0125 });

    db.recordUpdate(132, 232, 331, 431, "codex work");
    const codex = db.enqueueJob({
      updateId: 132,
      telegramMessageId: 232,
      chatId: 331,
      provider: "codex",
      prompt: "codex work",
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

    const summary = db.costSummary();
    expect(summary.jobs).toBe(2);
    expect(summary.pricedJobs).toBe(1);
    expect(summary.costUsd).toBe(0.0125);
    expect(summary.creditedJobs).toBe(1);
    expect(summary.codexCredits).toBe(0.02359375);
    expect(summary.providers.codex.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 50,
    });
    expect(db.getJob(codex)).toMatchObject({ model: "gpt-5.6-terra", cost_credits: 0.02359375 });
    db.close();
  });
});
