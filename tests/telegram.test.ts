import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramClient, TelegramRequestTimeoutError } from "../src/telegram.js";

const directories: string[] = [];

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("TelegramClient", () => {
  it("falls back to a document when Telegram rejects a generated image as a photo", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-telegram-"));
    directories.push(directory);
    const image = path.join(directory, "image.png");
    fs.writeFileSync(image, "png");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/sendPhoto")) {
        return response({ ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" });
      }
      if (url.endsWith("/sendDocument")) {
        return response({ ok: true, result: { message_id: 19 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const telegram = new TelegramClient("test-token-that-is-long-enough", "https://example.test", fetchImpl);

    await expect(telegram.sendFile(123, image)).resolves.toBe(19);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/bottest-token-that-is-long-enough/sendPhoto",
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/bottest-token-that-is-long-enough/sendDocument",
      expect.any(Object),
    );
  });

  it("bounds a stuck Telegram request", async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    ) as unknown as typeof fetch;
    const telegram = new TelegramClient(
      "test-token-that-is-long-enough",
      "https://example.test",
      fetchImpl,
      1,
    );

    await expect(telegram.sendText(123, "hello")).rejects.toBeInstanceOf(TelegramRequestTimeoutError);
  });

  it("sends safe Telegram HTML for concise Markdown formatting", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, result: { message_id: 21 } })) as unknown as typeof fetch;
    const telegram = new TelegramClient("test-token-that-is-long-enough", "https://example.test", fetchImpl);

    await telegram.sendText(123, "**Read this:** [docs](https://example.com/a?x=1&y=2) and `<safe>`." );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/bottest-token-that-is-long-enough/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          text: '<b>Read this:</b> <a href="https://example.com/a?x=1&amp;y=2">docs</a> and <code>&lt;safe&gt;</code>.',
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      }),
    );
  });
});
