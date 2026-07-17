import { describe, expect, it } from "vitest";
import { extractRemoteAttachments } from "../src/media.js";
import type { TelegramMessage } from "../src/telegram.js";

const baseMessage: TelegramMessage = {
  message_id: 1,
  chat: { id: 2, type: "private" },
};

describe("extractRemoteAttachments", () => {
  it("selects the largest Telegram photo", () => {
    const attachments = extractRemoteAttachments({
      ...baseMessage,
      photo: [
        { file_id: "small", file_unique_id: "a", width: 10, height: 10 },
        { file_id: "large", file_unique_id: "b", width: 100, height: 100 },
      ],
    });
    expect(attachments[0]?.fileId).toBe("large");
  });

  it("accepts arbitrary document types as files", () => {
    const attachments = extractRemoteAttachments({
      ...baseMessage,
      document: {
        file_id: "file",
        file_unique_id: "unique",
        file_name: "archive.tar.zst",
        mime_type: "application/zstd",
      },
    });
    expect(attachments).toEqual([
      expect.objectContaining({ fileId: "file", fileName: "archive.tar.zst", mimeType: "application/zstd" }),
    ]);
  });

  it("accepts audio, video, voice, animation, video notes, and stickers", () => {
    const variants: TelegramMessage[] = [
      { ...baseMessage, audio: { file_id: "audio", file_unique_id: "a" } },
      { ...baseMessage, video: { file_id: "video", file_unique_id: "v" } },
      { ...baseMessage, voice: { file_id: "voice", file_unique_id: "o" } },
      { ...baseMessage, animation: { file_id: "animation", file_unique_id: "n" } },
      { ...baseMessage, video_note: { file_id: "note", file_unique_id: "t" } },
      { ...baseMessage, sticker: { file_id: "sticker", file_unique_id: "s", is_animated: true } },
    ];
    expect(variants.map((message) => extractRemoteAttachments(message)[0]?.fileId)).toEqual([
      "audio",
      "video",
      "voice",
      "animation",
      "note",
      "sticker",
    ]);
  });
});
