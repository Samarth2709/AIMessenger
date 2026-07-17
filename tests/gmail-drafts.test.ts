import { describe, expect, it } from "vitest";
import {
  buildGmailDraftMime,
  gmailTokenPath,
  validateGmailDraftRequest,
} from "../src/gmail-drafts.js";
import { clientKeyMatches, createBroker } from "../src/gmail-draft-broker.js";

describe("Gmail draft broker helpers", () => {
  it("accepts configured accounts and produces a plain-text MIME message", () => {
    const draft = validateGmailDraftRequest({
      account: "samarth.kumbla@gmail.com",
      to: ["recipient@example.com"],
      cc: [],
      bcc: ["private@example.com"],
      subject: "Hello Iris",
      body: "First line\nSecond line",
    });

    expect(draft.account).toBe("samarth.kumbla@gmail.com");
    expect(buildGmailDraftMime(draft)).toContain("To: recipient@example.com\r\n");
    expect(buildGmailDraftMime(draft)).toContain("Bcc: private@example.com\r\n");
    expect(buildGmailDraftMime(draft)).toContain("Content-Transfer-Encoding: base64");
    expect(gmailTokenPath("/var/lib/aimessenger-mail", draft.account)).toBe(
      "/var/lib/aimessenger-mail/samarth-kumbla-gmail.token.json",
    );
  });

  it("rejects unconfigured accounts, missing recipients, and header injection", () => {
    expect(() =>
      validateGmailDraftRequest({
        account: "other@example.com",
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Body",
      }),
    ).toThrow("not enabled");
    expect(() =>
      validateGmailDraftRequest({
        account: "sk5335@columbia.edu",
        to: [],
        subject: "Hello",
        body: "Body",
      }),
    ).toThrow("At least one recipient");
    expect(() =>
      validateGmailDraftRequest({
        account: "sk5335@columbia.edu",
        to: ["recipient@example.com\nBcc: attacker@example.com"],
        subject: "Hello",
        body: "Body",
      }),
    ).toThrow("line breaks");
  });

  it("requires the local broker key and has no send route", async () => {
    let draftCalls = 0;
    const broker = createBroker(
      { dataDir: "/unused", port: 0, clientKey: "a".repeat(64) },
      async () => {
        draftCalls += 1;
        return { draftId: "draft-1", messageId: "message-1" };
      },
    );
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    const address = broker.address();
    if (!address || typeof address === "string") throw new Error("Broker did not bind TCP.");
    const base = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${base}/v1/drafts`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    const send = await fetch(`${base}/v1/send`, { method: "POST", body: "{}" });
    expect(send.status).toBe(404);
    expect(draftCalls).toBe(0);
    expect(clientKeyMatches("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(clientKeyMatches("wrong", "a".repeat(64))).toBe(false);
    await new Promise<void>((resolve, reject) => broker.close((error) => (error ? reject(error) : resolve())));
  });
});
