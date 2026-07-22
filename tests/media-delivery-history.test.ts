import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConversationContext, isFollowupRequest } from "../src/conversation-context.js";
import { AppDatabase } from "../src/db.js";
import { buildPrompt, parseAgentResult } from "../src/providers/structured.js";

const directories: string[] = [];

function createDb(): AppDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-media-history-"));
  directories.push(directory);
  return new AppDatabase(path.join(directory, "test.sqlite"));
}

function completeDeliveredImage(db: AppDatabase, jobId: number, chatId: number): number {
  const transcriptId = db.completeJob(jobId, "Lucy Gray Baird.", "codex", "thread-1", [
    {
      chatId,
      kind: "document",
      payload: { path: "/private/jobs/1/output/lucy.jpg", caption: "Lucy Gray 1" },
      media: {
        fileName: "lucy.jpg",
        mediaType: "image/jpeg",
        sha256: "a".repeat(64),
        caption: "Lucy Gray 1",
        provenance: "web",
        sourceUrl: "https://images.example.test/lucy.jpg",
      },
    },
  ]);
  const outbound = db.claimNextOutbox()!;
  db.completeOutbox(outbound.id, 345);
  return transcriptId;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("media delivery history", () => {
  it("records confirmed media delivery with safe provenance in exact history", () => {
    const db = createDb();
    db.recordUpdate(1, 2, 3, 4, "Show me Lucy Gray.");
    const jobId = db.enqueueJob({
      updateId: 1,
      telegramMessageId: 2,
      chatId: 3,
      provider: "codex",
      prompt: "Show me Lucy Gray.",
      attachments: [],
    });
    const transcriptId = completeDeliveredImage(db, jobId, 3);

    expect(db.recentHistory(3)[0]).toMatchObject({ id: transcriptId, media_count: 1 });
    expect(db.readHistory([transcriptId], 3)[0]?.attachments).toEqual([
      {
        fileName: "lucy.jpg",
        mediaType: "image/jpeg",
        caption: "Lucy Gray 1",
        provenance: "web",
        sourceUrl: "https://images.example.test/lucy.jpg",
        deliveryStatus: "sent",
        telegramMessageId: 345,
      },
    ]);
    db.close();
  });

  it("injects recent delivered images even after the normal context window", () => {
    const db = createDb();
    db.recordUpdate(10, 20, 30, 40, "Show me Lucy Gray.");
    const first = db.enqueueJob({
      updateId: 10,
      telegramMessageId: 20,
      chatId: 30,
      provider: "codex",
      prompt: "Show me Lucy Gray.",
      attachments: [],
    });
    completeDeliveredImage(db, first, 30);
    db.recordUpdate(11, 21, 30, 40, "Send an unrelated generated image.");
    const newerImage = db.enqueueJob({
      updateId: 11,
      telegramMessageId: 21,
      chatId: 30,
      provider: "codex",
      prompt: "Send an unrelated generated image.",
      attachments: [],
    });
    db.completeJob(newerImage, "Here is the unrelated image.", "codex", "thread-1", [
      {
        chatId: 30,
        kind: "document",
        payload: { path: "/private/jobs/11/output/unrelated.png", caption: "Unrelated generated image" },
        media: {
          fileName: "unrelated.png",
          mediaType: "image/png",
          sha256: "b".repeat(64),
          caption: "Unrelated generated image",
          provenance: "generated",
        },
      },
    ]);
    const newerOutbound = db.claimNextOutbox()!;
    db.completeOutbox(newerOutbound.id, 346);
    for (const updateId of [12, 13, 14]) {
      db.recordUpdate(updateId, updateId + 10, 30, 40, `Unrelated turn ${updateId}.`);
      const intervening = db.enqueueJob({
        updateId,
        telegramMessageId: updateId + 10,
        chatId: 30,
        provider: "codex",
        prompt: `Unrelated turn ${updateId}.`,
        attachments: [],
      });
      db.completeJob(intervening, `Unrelated reply ${updateId}.`, "codex", "thread-1");
    }
    const prompt = "In our earlier Lucy Gray conversation, did you send images? If so, state the number and their recorded origin.";
    db.recordUpdate(15, 25, 30, 40, prompt);
    const followup = db.enqueueJob({
      updateId: 15,
      telegramMessageId: 25,
      chatId: 30,
      provider: "codex",
      prompt,
      attachments: [],
    });

    expect(isFollowupRequest(prompt)).toBe(true);
    expect(db.recentHistoryWithMedia(30, 6, db.getJob(followup)!.user_message_id)).toHaveLength(2);
    expect(buildConversationContext(db, db.getJob(followup)!)).toContain(
      "[delivery] sent image “Lucy Gray 1” (origin: web https://images.example.test/lucy.jpg)",
    );
    expect(buildConversationContext(db, db.getJob(followup)!)).toContain(
      "[delivery] sent image “Unrelated generated image” (origin: generated)",
    );
    db.close();
  });

  it("backfills previously delivered documents with unknown provenance", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-media-history-"));
    directories.push(directory);
    const dbPath = path.join(directory, "test.sqlite");
    const first = new AppDatabase(dbPath);
    first.recordUpdate(12, 22, 32, 42, "Show me an older image.");
    const jobId = first.enqueueJob({
      updateId: 12,
      telegramMessageId: 22,
      chatId: 32,
      provider: "codex",
      prompt: "Show me an older image.",
      attachments: [],
    });
    const transcriptId = first.completeJob(jobId, "Here is the image.", "codex", "thread-1", [
      {
        chatId: 32,
        kind: "document",
        payload: { path: "/private/jobs/12/output/older-image.jpg", caption: "Older image" },
      },
    ]);
    const outbound = first.claimNextOutbox()!;
    first.completeOutbox(outbound.id, 346);
    first.close();

    const migrated = new AppDatabase(dbPath);
    expect(migrated.readHistory([transcriptId], 32)[0]?.attachments).toEqual([
      {
        fileName: "older-image.jpg",
        mediaType: "image/jpeg",
        caption: "Older image",
        provenance: "unknown",
        sourceUrl: null,
        deliveryStatus: "sent",
        telegramMessageId: 346,
      },
    ]);
    migrated.close();
  });

  it("does not attach legacy media when identical assistant results are ambiguous", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-media-history-"));
    directories.push(directory);
    const dbPath = path.join(directory, "test.sqlite");
    const first = new AppDatabase(dbPath);
    first.recordUpdate(20, 30, 40, 50, "First image request.");
    const firstJob = first.enqueueJob({
      updateId: 20,
      telegramMessageId: 30,
      chatId: 40,
      provider: "codex",
      prompt: "First image request.",
      attachments: [],
    });
    first.recordUpdate(21, 31, 40, 50, "Second request.");
    const secondJob = first.enqueueJob({
      updateId: 21,
      telegramMessageId: 31,
      chatId: 40,
      provider: "codex",
      prompt: "Second request.",
      attachments: [],
    });
    const firstTranscript = first.completeJob(firstJob, "Done.", "codex", "thread-1", [
      {
        chatId: 40,
        kind: "document",
        payload: { path: "/private/jobs/20/output/ambiguous.jpg", caption: "Ambiguous image" },
      },
    ]);
    first.completeJob(secondJob, "Done.", "codex", "thread-1");
    first.close();

    const migrated = new AppDatabase(dbPath);
    expect(migrated.readHistory([firstTranscript], 40)[0]?.attachments).toEqual([]);
    migrated.close();
  });

  it("uses named conversation context and preserves only evidence-backed web provenance", () => {
    const result = parseAgentResult(
      JSON.stringify({
        message: "Here is the image.",
        attachments: [
          {
            path: "/tmp/lucy.jpg",
            caption: "Lucy Gray 1",
            provenance: "web",
            source_url: "https://images.example.test/lucy.jpg?tracking=private#preview",
          },
        ],
      }),
    );
    const prompt = buildPrompt(
      "# Iris",
      [],
      { provider: "codex" },
      "Did you send these images?",
      undefined,
      { attachmentPaths: [], conversationContext: "[assistant] Prior sent image" },
    );

    expect(result.attachments[0]).toMatchObject({
      provenance: "web",
      sourceUrl: "https://images.example.test/lucy.jpg",
    });
    expect(prompt).toContain("<private_conversation_context>");
    expect(prompt).toContain("authoritative delivery facts");
    expect(prompt).not.toContain("<attachment_transcripts>");
  });
});
