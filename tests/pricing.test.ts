import { describe, expect, it } from "vitest";
import { codexCreditsForUsage } from "../src/pricing.js";

describe("codexCreditsForUsage", () => {
  it("uses the selected model's official Codex credit rates", () => {
    expect(
      codexCreditsForUsage("gpt-5.6-terra", {
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 50,
      }),
    ).toBe(0.02359375);
  });

  it("does not guess a price for an unknown model", () => {
    expect(
      codexCreditsForUsage("gpt-5.3-codex-spark", {
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 50,
      }),
    ).toBeUndefined();
  });
});
