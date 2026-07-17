import fs from "node:fs";
import { STATELESS_SESSION_ID, type TokenUsage } from "../types.js";
import type { GatewayToolDefinition } from "../memory.js";
import type { AgentSkill } from "../skills.js";
import { buildPrompt, parseAgentResult } from "./structured.js";
import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./types.js";

const MAX_SKILL_BYTES = 32 * 1024;
const MAX_TOOL_CALL_ROUNDS = 4;

function responseMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? [(part as { text: string }).text]
          : [],
      )
      .join("\n");
  }
  return "";
}

function choiceMessage(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function toolCallsFrom(payload: unknown): Array<{ id: string; name: string; arguments: string }> {
  const raw = choiceMessage(payload)?.tool_calls;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Gateway returned malformed tool calls.");
  return raw.map((call) => {
    if (!call || typeof call !== "object") throw new Error("Gateway returned malformed tool call.");
    const record = call as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (
      typeof record.id !== "string" ||
      record.type !== "function" ||
      typeof record.function?.name !== "string" ||
      typeof record.function.arguments !== "string"
    ) {
      throw new Error("Gateway returned malformed tool call.");
    }
    return { id: record.id, name: record.function.name, arguments: record.function.arguments };
  });
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : fallback;
}

function rejectsToolChoice(payload: unknown): boolean {
  return /does not support (?:this )?tool_choice/i.test(errorMessage(payload, ""));
}

function rejectedToolResult(error: unknown): { ok: false; error: { code: string; message: string } } {
  const message = error instanceof Error ? error.message : "Memory tool request failed.";
  return {
    ok: false,
    error: {
      code: "memory_tool_rejected",
      message: `${message.slice(0, 500)} Memory tools can access only the Markdown vault, not skill or host files.`,
    },
  };
}

function skillToolDefinitions(skills: AgentSkill[]): GatewayToolDefinition[] {
  if (!skills.length) return [];
  return [
    {
      type: "function",
      function: {
        name: "skill_read",
        description: "Read instructions for one supplied skill by name. This never reads arbitrary host files.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string", enum: skills.map((skill) => skill.name) } },
          required: ["name"],
        },
      },
    },
  ];
}

function skillFromInput(skills: AgentSkill[], input: unknown): AgentSkill {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { name?: unknown }).name !== "string") {
    throw new Error("skill_read requires a supplied skill name.");
  }
  const skill = skills.find((candidate) => candidate.name === (input as { name: string }).name);
  if (!skill) throw new Error("skill_read requested a skill that was not supplied to this job.");
  return skill;
}

function skillFromMemoryRead(skills: AgentSkill[], name: string, input: unknown): AgentSkill | undefined {
  if (name !== "memory_read" || !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const requestedPath = (input as { path?: unknown }).path;
  return typeof requestedPath === "string" ? skills.find((skill) => skill.path === requestedPath) : undefined;
}

function readSkill(skill: AgentSkill): Record<string, string> {
  const instructions = fs.readFileSync(skill.path, "utf8");
  if (Buffer.byteLength(instructions) > MAX_SKILL_BYTES) throw new Error(`Skill is too large: ${skill.name}`);
  return { name: skill.name, instructions };
}

function responseUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const promptDetails =
    record.prompt_tokens_details && typeof record.prompt_tokens_details === "object"
      ? (record.prompt_tokens_details as Record<string, unknown>)
      : {};
  const inputTokens = numberAt(record.input_tokens) ?? numberAt(record.prompt_tokens) ?? 0;
  const cachedInputTokens =
    numberAt(record.cached_input_tokens) ?? numberAt(promptDetails.cached_tokens) ?? 0;
  const outputTokens = numberAt(record.output_tokens) ?? numberAt(record.completion_tokens) ?? 0;
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens };
}

function responseCost(payload: unknown, headers: Headers): number | undefined {
  const headerValue = headers.get("x-litellm-response-cost");
  if (headerValue?.trim()) {
    const headerCost = Number(headerValue);
    if (Number.isFinite(headerCost) && headerCost >= 0) return headerCost;
  }
  if (!payload || typeof payload !== "object") return undefined;
  return numberAt((payload as { response_cost?: unknown }).response_cost);
}

function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class GatewayProvider implements AgentProvider {
  constructor(
    private readonly apiBase: string,
    private readonly apiKey: string | undefined,
    private readonly request: typeof fetch = fetch,
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    if (!this.apiKey) throw new Error("The AI Security gateway is not configured.");
    if (!input.model) throw new Error("Choose an AI Security gateway model with /model first.");
    if (!input.memory?.toolExecutor) {
      throw new Error("Gateway memory tools are unavailable; gateway models must support the memory tool loop.");
    }
    const prompt = buildPrompt(
      input.identity,
      input.skills,
      input,
      input.prompt,
      input.memory,
      input.attachmentPaths,
    ) +
      (input.skills.length
        ? "\n\n<gateway_skill_access>For a listed skill, call skill_read with its name. Do not use memory_read for skill files.</gateway_skill_access>"
        : "");
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];
    const tools = [...input.memory.toolExecutor.definitions, ...skillToolDefinitions(input.skills)];
    const seenCalls = new Set<string>();
    const rawOutputs: string[] = [];
    let usage: TokenUsage | undefined;
    let costUsd: number | undefined;
    let requireToolCall = true;
    let toolRounds = 0;

    for (let attempt = 0; attempt < MAX_TOOL_CALL_ROUNDS + 2; attempt += 1) {
      const response = await this.request(`${this.apiBase.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          messages,
          tools,
          ...(requireToolCall ? { tool_choice: attempt === 0 ? "required" : "auto" } : {}),
          parallel_tool_calls: false,
        }),
        signal: input.signal,
      });
      const rawOutput = await response.text();
      rawOutputs.push(rawOutput);
      let payload: unknown = rawOutput;
      try {
        payload = JSON.parse(rawOutput);
      } catch {
        // A non-JSON successful response remains valid only as a final answer without tool calls.
      }
      if (!response.ok) {
        if (requireToolCall && rejectsToolChoice(payload)) {
          requireToolCall = false;
          continue;
        }
        throw new Error(`AI Security gateway failed: ${errorMessage(payload, `HTTP ${response.status}`)}`);
      }
      usage = responseUsage(payload) ?? usage;
      costUsd = responseCost(payload, response.headers) ?? costUsd;
      const calls = toolCallsFrom(payload);
      if (!calls.length) {
        if (requireToolCall && attempt === 0) {
          throw new Error("Gateway did not honor the required memory tool call; choose a tool-capable gateway model.");
        }
        const message = responseMessage(payload) || (typeof payload === "string" ? payload : "");
        if (!message.trim()) throw new Error("Gateway completed without a final response.");
        return {
          result: parseAgentResult(message),
          sessionId: STATELESS_SESSION_ID,
          rawOutput: rawOutputs.join("\n"),
          ...(usage || costUsd !== undefined
            ? { metrics: { ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) } }
            : {}),
        };
      }
      if (toolRounds >= MAX_TOOL_CALL_ROUNDS) {
        throw new Error("Gateway exceeded the memory tool-call round limit.");
      }
      toolRounds += 1;
      if (calls.length > 4) throw new Error("Gateway requested too many memory tools in one round.");
      const assistant = choiceMessage(payload);
      if (!assistant) throw new Error("Gateway returned tool calls without an assistant message.");
      messages.push({ role: "assistant", content: assistant.content ?? "", tool_calls: assistant.tool_calls });
      for (const call of calls) {
        let argumentsValue: unknown;
        try {
          argumentsValue = JSON.parse(call.arguments);
        } catch {
          throw new Error(`Gateway returned invalid JSON arguments for ${call.name}.`);
        }
        const fingerprint = `${call.name}:${JSON.stringify(argumentsValue)}`;
        if (seenCalls.has(fingerprint)) throw new Error("Gateway repeated an identical memory tool call.");
        seenCalls.add(fingerprint);
        let result: unknown;
        try {
          const skill =
            call.name === "skill_read"
              ? skillFromInput(input.skills, argumentsValue)
              : skillFromMemoryRead(input.skills, call.name, argumentsValue);
          result = skill
            ? readSkill(skill)
            : await input.memory.toolExecutor.execute(call.name, argumentsValue);
        } catch (error) {
          if (input.signal.aborted) throw error;
          result = rejectedToolResult(error);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("Gateway completed without a final response.");
  }
}
