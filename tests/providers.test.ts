import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";
import { GatewayProvider } from "../src/providers/gateway.js";
import { ModelRoutedProvider } from "../src/providers/routed.js";
import type { AgentProvider } from "../src/providers/types.js";

const tempDirs: string[] = [];

function executable(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-provider-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fake-agent");
  fs.writeFileSync(file, `#!/bin/bash\n${contents}\n`, { mode: 0o700 });
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const baseInput = {
  identity: "You are Iris.",
  skills: [],
  provider: "codex" as const,
  model: "test-model",
  prompt: "hello",
  memory: {
    map: "# Memory index\n\nUse memory tools.",
    cliCommand: "node /memory-cli.js",
    toolExecutor: {
      definitions: [],
      execute: vi.fn(async () => ({ results: [] })),
    },
  },
  attachmentPaths: [],
  sessionId: null,
  workingDirectory: os.tmpdir(),
  schemaPath: path.resolve("schemas/agent-result.schema.json"),
  signal: new AbortController().signal,
};

describe("provider adapters", () => {
  it("captures the Codex thread and structured final event", async () => {
    const argsFile = path.join(os.tmpdir(), `aimessenger-codex-args-${process.pid}.txt`);
    const command = executable(
      `printf '%s\\n' "$@" > "${argsFile}"\n` +
        `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-123"}' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"message\\":\\"codex ok\\",\\"attachments\\":[]}"}}' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":50}}'`,
    );
    const output = await new CodexProvider(command).run(baseInput);
    expect(output.sessionId).toBe("thread-123");
    expect(output.result).toEqual({ message: "codex ok", attachments: [] });
    expect(output.metrics).toEqual({
      usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
    });
    expect(fs.readFileSync(argsFile, "utf8")).toContain("--ignore-user-config");
    expect(fs.readFileSync(argsFile, "utf8")).toContain("--model");
    expect(fs.readFileSync(argsFile, "utf8")).toContain("test-model");
    expect(fs.readFileSync(argsFile, "utf8")).toContain("You are Iris.");
    fs.rmSync(argsFile, { force: true });
  });

  it("captures Claude structured_output and session ID", async () => {
    const command = executable(
      `printf '%s\\n' '{"type":"result","session_id":"claude-123","is_error":false,"total_cost_usd":0.0125,"structured_output":{"message":"claude ok","attachments":[]}}'`,
    );
    const output = await new ClaudeProvider(command).run(baseInput);
    expect(output.sessionId).toBe("claude-123");
    expect(output.result).toEqual({ message: "claude ok", attachments: [] });
    expect(output.metrics).toEqual({ costUsd: 0.0125, usage: undefined });
  });

  it("keeps a malformed Codex structured result empty for retry handling", async () => {
    const command = executable(
      `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-empty"}' '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'`,
    );
    const output = await new CodexProvider(command).run(baseInput);
    expect(output.result).toEqual({ message: "", attachments: [] });
  });

  it("calls the AI Security gateway with the selected model", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "memory_search", arguments: '{"query":"hello"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "gateway ok" } }],
            usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 25 }, completion_tokens: 50 },
          }),
          { headers: { "x-litellm-response-cost": "0.0042" } },
        ),
      );
    const output = await new GatewayProvider("http://gateway.test/v1", "test-key", request).run(baseInput);

    expect(output.result).toEqual({ message: "gateway ok", attachments: [] });
    expect(output.sessionId).toBe("__aimessenger_stateless__");
    expect(output.metrics).toEqual({
      costUsd: 0.0042,
      usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 50 },
    });
    expect(request).toHaveBeenCalledWith(
      "http://gateway.test/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    expect(baseInput.memory.toolExecutor.execute).toHaveBeenCalledWith("memory_search", { query: "hello" });
  });

  it("does not treat an absent gateway cost header as a zero-dollar charge", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call-2",
                      type: "function",
                      function: { name: "memory_search", arguments: '{"query":"cost"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "gateway ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        ),
      );

    const output = await new GatewayProvider("http://gateway.test/v1", "test-key", request).run(baseInput);

    expect(output.metrics).toEqual({
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    });
  });

  it("rejects a gateway model that does not honor required memory tools", async () => {
    const request = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "gateway ok" } }] })),
    );
    await expect(new GatewayProvider("http://gateway.test/v1", "test-key", request).run(baseInput)).rejects.toThrow(
      "required memory tool call",
    );
  });

  it("rejects repeated memory tool calls", async () => {
    const toolCall = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call-repeat",
                type: "function",
                function: { name: "memory_search", arguments: '{"query":"repeat"}' },
              },
            ],
          },
        },
      ],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(toolCall)))
      .mockResolvedValueOnce(new Response(JSON.stringify(toolCall)));
    await expect(new GatewayProvider("http://gateway.test/v1", "test-key", request).run(baseInput)).rejects.toThrow(
      "repeated an identical",
    );
  });

  it("rejects malformed gateway tool arguments", async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call-bad",
                    type: "function",
                    function: { name: "memory_search", arguments: "not-json" },
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    await expect(new GatewayProvider("http://gateway.test/v1", "test-key", request).run(baseInput)).rejects.toThrow(
      "invalid JSON arguments",
    );
  });

  it("bounds gateway memory tool rounds", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: `call-${calls}`,
                    type: "function",
                    function: { name: "memory_search", arguments: JSON.stringify({ query: `query-${calls}` }) },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    await expect(new GatewayProvider("http://gateway.test/v1", "test-key", request).run(baseInput)).rejects.toThrow(
      "round limit",
    );
  });

  it("routes configured gateway models without changing Codex behavior", async () => {
    const codex = { run: vi.fn(async () => ({ result: { message: "codex", attachments: [] }, sessionId: "c", rawOutput: "" })) } satisfies AgentProvider;
    const gateway = { run: vi.fn(async () => ({ result: { message: "gateway", attachments: [] }, sessionId: "g", rawOutput: "" })) } satisfies AgentProvider;
    const routed = new ModelRoutedProvider(codex, gateway, new Set(["glm-5.2"]));

    await routed.run({ ...baseInput, model: "glm-5.2" });
    await routed.run({ ...baseInput, model: "gpt-test" });

    expect(gateway.run).toHaveBeenCalledTimes(1);
    expect(codex.run).toHaveBeenCalledTimes(1);
  });
});
