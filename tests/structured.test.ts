import { describe, expect, it } from "vitest";
import { parseAgentResult } from "../src/providers/structured.js";

describe("parseAgentResult", () => {
  it("parses schema-compliant JSON from a code fence", () => {
    expect(
      parseAgentResult(
        '```json\n{"message":"done","attachments":[{"path":"/tmp/a.pdf"}]}\n```',
        "fallback",
      ),
    ).toEqual({ message: "done", attachments: [{ path: "/tmp/a.pdf" }] });
  });

  it("uses structured_output when Claude returns it", () => {
    expect(
      parseAgentResult(
        { structured_output: { message: "ok", attachments: [] }, result: "ignored" },
        "fallback",
      ),
    ).toEqual({ message: "ok", attachments: [] });
  });

  it("falls back to plain text", () => {
    expect(parseAgentResult("plain answer", "fallback")).toEqual({
      message: "plain answer",
      attachments: [],
    });
  });
});
