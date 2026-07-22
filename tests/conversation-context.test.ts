import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db.js";
import { buildConversationContext, decideConversationContext, isFollowupRequest } from "../src/conversation-context.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fixture(): { db: AppDatabase; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-context-"));
  return { db: new AppDatabase(path.join(directory, "test.sqlite")), directory };
}

describe("conversation context", () => {
  it("rehydrates a bounded prior task for a referential follow-up", () => {
    const { db, directory } = fixture();
    try {
      db.recordUpdate(1, 1, 9, 9, "Find a used MacBook Pro with 24 GB RAM.");
      const first = db.enqueueJob({
        updateId: 1,
        telegramMessageId: 1,
        chatId: 9,
        provider: "codex",
        prompt: "Find a used MacBook Pro with 24 GB RAM.",
        attachments: [],
      });
      db.completeJob(first, "I found two listings.", "codex", "thread");
      db.recordUpdate(2, 2, 9, 9, "Complete my request");
      const second = db.enqueueJob({
        updateId: 2,
        telegramMessageId: 2,
        chatId: 9,
        provider: "codex",
        prompt: "Complete my request",
        attachments: [],
      });

      expect(isFollowupRequest("Complete my request")).toBe(true);
      expect(buildConversationContext(db, db.getJob(second)!)).toContain("MacBook Pro");
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not inject prior turns for a fresh question", () => {
    expect(isFollowupRequest("What is the weather today?")).toBe(false);
  });

  it("keeps schedule follow-up context for a long itinerary request", () => {
    const { db, directory } = fixture();
    try {
      db.recordUpdate(3, 3, 9, 9, "Inspect the schedule.");
      const first = db.enqueueJob({
        updateId: 3,
        telegramMessageId: 3,
        chatId: 9,
        provider: "codex",
        prompt: "Inspect the schedule.",
        attachments: [],
      });
      db.completeJob(first, "The schedule has a Saturday preliminary and Sunday final.", "codex", "thread");
      db.recordUpdate(4, 4, 9, 9, "long referential request");
      const job = db.enqueueJob({
        updateId: 4,
        telegramMessageId: 4,
        chatId: 9,
        provider: "codex",
        prompt: `Use this schedule to plan my trip. ${"details ".repeat(80)}`,
        attachments: [],
      });

      expect(decideConversationContext(db, db.getJob(job)!)).toMatchObject({
        reason: "included",
        referenceCount: 2,
      });
      expect(buildConversationContext(db, db.getJob(job)!)).toContain("Saturday preliminary");
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
