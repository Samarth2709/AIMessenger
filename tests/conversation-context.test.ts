import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db.js";
import { buildConversationContext, isFollowupRequest } from "../src/conversation-context.js";
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
});
