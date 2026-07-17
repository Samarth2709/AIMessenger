import { describe, expect, it } from "vitest";
import { parseCodexModels, parseGatewayModels } from "../src/models.js";

describe("parseCodexModels", () => {
  it("keeps selectable Codex models in catalog order", () => {
    expect(
      parseCodexModels(
        JSON.stringify({
          models: [
            { slug: "hidden", visibility: "hidden" },
            { slug: "gpt-test", display_name: "GPT Test", description: "Test model", visibility: "list" },
          ],
        }),
      ),
    ).toEqual([{ id: "gpt-test", name: "GPT Test", description: "Test model" }]);
  });
});

describe("parseGatewayModels", () => {
  it("keeps gateway model IDs in response order", () => {
    expect(
      parseGatewayModels(JSON.stringify({ data: [{ id: "glm-5.2" }, { id: "deepseek-v4-flash" }] })),
    ).toEqual([
      { id: "glm-5.2", name: "glm-5.2", description: "AI Security gateway", source: "AI Security" },
      {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        description: "AI Security gateway",
        source: "AI Security",
      },
    ]);
  });
});
