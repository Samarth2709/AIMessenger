import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/telegram.js";

function json(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
  });
}

describe("TelegramClient", () => {
  it("advertises the cost command to Telegram", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/deleteWebhook")) return json(true);
      if (url.endsWith("/getMe")) return json({ id: 1, username: "testbot" });
      if (url.endsWith("/setMyCommands")) {
        const body = JSON.parse(String(init?.body)) as {
          commands: Array<{ command: string; description: string }>;
        };
        expect(body.commands).toContainEqual({
          command: "cost",
          description: "Show provider-reported spend",
        });
        return json(true);
      }
      throw new Error(`Unexpected Telegram method: ${url}`);
    }) as unknown as typeof fetch;
    const client = new TelegramClient("test-token-that-is-long-enough", "https://example.test", fetchImpl);

    await expect(client.initialize()).resolves.toEqual({ id: 1, username: "testbot" });
  });
});
