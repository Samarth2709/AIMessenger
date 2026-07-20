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

  it("preserves the internal memory handoff fields", () => {
    expect(
      parseAgentResult(
        '{"message":"done","attachments":[],"session_disposition":"handoff","memory_refs":["projects/app/state.md"]}',
      ),
    ).toEqual({
      message: "done",
      attachments: [],
      sessionDisposition: "handoff",
      memoryRefs: ["projects/app/state.md"],
    });
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
      undefined,
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
      undefined,
      [],
    );
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("Read /skills/research/SKILL.md before using it.");
    expect(prompt).toContain("model: test-model");
  });

  it("provides a compact vault map instead of transcript context", () => {
    const prompt = buildPrompt(
      "# Iris",
      [],
      { provider: "codex", model: "test-model" },
      "continue the project",
      {
        map: "# Memory index\n\n## Active projects\n- AIMessenger",
        cliCommand: "node /memory-cli.js",
        userSource: "inbound_update:42",
        toolExecutor: { definitions: [], execute: async () => ({}) },
      },
      [],
    );
    expect(prompt).toContain("<memory_system>");
    expect(prompt).toContain("# Memory index");
    expect(prompt).toContain("never skill or host file paths");
    expect(prompt).toContain("inbound_update:42");
    expect(prompt).toContain("Never write task requests");
    expect(prompt).toContain('history_search with {"recent":true}');
    expect(prompt).toContain("History search always excludes the current inbound message");
    expect(prompt).not.toContain("conversation_context");
  });

  it("adds bounded raw history only when the service has identified a follow-up", () => {
    const prompt = buildPrompt(
      "# Iris",
      [],
      { provider: "codex", model: "test-model" },
      "Complete my request",
      undefined,
      [],
      undefined,
      "[user] Find a used MacBook Pro.\n\n[assistant] I found two listings.",
    );

    expect(prompt).toContain("<private_conversation_context>");
    expect(prompt).toContain("MacBook Pro");
  });

  it("injects a bounded local transcript only when transcription succeeds", () => {
    const withTranscript = buildPrompt(
      "# Iris",
      [],
      { provider: "codex", model: "test-model" },
      "Summarize this note",
      undefined,
      ["/jobs/1/input/voice.ogg"],
      "- voice.ogg [00:00] (en): Schedule the meeting for noon.",
    );
    const withoutTranscript = buildPrompt(
      "# Iris",
      [],
      { provider: "codex", model: "test-model" },
      "Inspect this file",
      undefined,
      ["/jobs/2/input/file.pdf"],
    );

    expect(withTranscript).toContain("<attachment_transcripts>");
    expect(withTranscript).toContain("Schedule the meeting for noon.");
    expect(withoutTranscript).not.toContain("<attachment_transcripts>");
  });
});
