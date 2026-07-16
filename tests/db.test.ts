import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db.js";

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

  it("carries unseen cross-provider transcript into a provider", () => {
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
    const second = db.getJob(secondId)!;
    const context = db.getContext("claude", second.user_message_id);
    expect(context).toContain("first");
    expect(context).toContain("codex answer");
    expect(context).not.toContain("second");
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

  it("does not carry canceled or interrupted prompts into a later unrestricted run", () => {
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
    const next = db.enqueueJob({
      updateId: 103,
      telegramMessageId: 203,
      chatId: 301,
      provider: "codex",
      prompt: "new request",
      attachments: [],
    });
    const context = db.getContext("codex", db.getJob(next)!.user_message_id);
    expect(context).not.toContain("dangerous stopped request");
    expect(context).toContain("safe answer");
    db.close();
  });

  it("honors the explicit new-session transcript boundary", () => {
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
    const fresh = db.enqueueJob({
      updateId: 112,
      telegramMessageId: 212,
      chatId: 311,
      provider: "claude",
      prompt: "fresh request",
      attachments: [],
    });
    expect(db.getContext("claude", db.getJob(fresh)!.user_message_id)).toBe("");
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
});
