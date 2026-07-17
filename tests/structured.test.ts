import { describe, expect, it } from "vitest";
import { buildPrompt, parseAgentResult } from "../src/providers/structured.js";

describe("parseAgentResult", () => {
  it("parses schema-compliant JSON from a code fence", () => {
    expect(
      parseAgentResult(
        '```json\n{"message":"done","attachments":[{"path":"/tmp/a.pdf"}]}\n```',
      ),
    ).toEqual({ message: "done", attachments: [{ path: "/tmp/a.pdf" }] });
  });

  it("uses structured_output when Claude returns it", () => {
    expect(
      parseAgentResult({ structured_output: { message: "ok", attachments: [] }, result: "ignored" }),
    ).toEqual({ message: "ok", attachments: [] });
  });

  it("falls back to plain text", () => {
    expect(parseAgentResult("plain answer")).toEqual({
      message: "plain answer",
      attachments: [],
    });
  });

  it("preserves an empty result for the worker to fail retryably", () => {
    expect(parseAgentResult("{}")).toEqual({ message: "", attachments: [] });
    expect(parseAgentResult("")).toEqual({ message: "", attachments: [] });
  });

  it("uses the supplied identity as the first prompt section", () => {
    const prompt = buildPrompt(
      "# Iris\nBe direct.",
      [],
      { provider: "codex", model: "test-model" },
      "hello",
      "",
      [],
    );
    expect(prompt.startsWith("# Iris\nBe direct.")).toBe(true);
    expect(prompt).toContain("<user_request>\nhello\n</user_request>");
  });

  it("exposes portable skills without provider-specific configuration", () => {
    const prompt = buildPrompt(
      "# Iris",
      [{ name: "research", description: "Research current facts.", path: "/skills/research/SKILL.md" }],
      { provider: "codex", model: "test-model" },
      "research this",
      "",
      [],
    );
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("Read /skills/research/SKILL.md before using it.");
    expect(prompt).toContain("model: test-model");
  });
});
