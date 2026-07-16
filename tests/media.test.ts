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

  it("rejects unsupported documents", () => {
    expect(() =>
      extractRemoteAttachments({
        ...baseMessage,
        document: {
          file_id: "file",
          file_unique_id: "unique",
          file_name: "malware.exe",
          mime_type: "application/octet-stream",
        },
      }),
    ).toThrow(/Unsupported document type/);
  });
});
