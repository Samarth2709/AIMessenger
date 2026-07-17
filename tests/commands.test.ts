import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";
import { chunkText } from "../src/chunk.js";

describe("parseCommand", () => {
  it("parses provider switches and bot-addressed commands", () => {
    expect(parseCommand("/claude")).toEqual({ kind: "switch", provider: "claude" });
    expect(parseCommand("/codex@SamarthWorkBot")).toEqual({
      kind: "switch",
      provider: "codex",
    });
  });

  it("validates reset and retry arguments", () => {
    expect(parseCommand("/new all")).toEqual({ kind: "new", target: "all" });
    expect(parseCommand("/retry 42")).toEqual({ kind: "retry", jobId: 42 });
    expect(parseCommand("/retry nope")).toEqual({ kind: "unknown", name: "/retry" });
  });

  it("parses cost windows", () => {
    expect(parseCommand("/cost")).toEqual({ kind: "cost", window: "summary" });
    expect(parseCommand("/cost all")).toEqual({ kind: "cost", window: "all" });
    expect(parseCommand("/cost 30")).toEqual({ kind: "cost", window: "days", days: 30 });
    expect(parseCommand("/cost 0")).toEqual({ kind: "unknown", name: "/cost" });
  });
});

describe("chunkText", () => {
  it("keeps short messages intact", () => {
    expect(chunkText(" hello ")).toEqual(["hello"]);
  });

  it("splits long messages and numbers each part", () => {
    const chunks = chunkText("alpha ".repeat(1000), 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 210)).toBe(true);
    expect(chunks[0]).toMatch(/^\[1\/\d+\]/);
  });
});
