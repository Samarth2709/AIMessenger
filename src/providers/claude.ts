import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { JobMetrics, TokenUsage } from "../types.js";
import {
  ProviderRunError,
  type AgentProvider,
  type ProviderRunInput,
  type ProviderRunOutput,
} from "./types.js";
import { buildPrompt, parseAgentResult } from "./structured.js";
import { runProcess } from "./process.js";

export class ClaudeProvider implements AgentProvider {
  constructor(
    private readonly command = "claude",
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    const prompt = buildPrompt(
      input.identity,
      input.skills,
      input,
      input.prompt,
      input.memory,
      input.attachmentPaths,
    );
    const schema = await fs.readFile(input.schemaPath, "utf8");
    const newSessionId = input.sessionId ?? randomUUID();
    const args = [
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--json-schema",
      schema,
      ...(input.model ? ["--model", input.model] : []),
      ...(input.sessionId ? ["--resume", input.sessionId] : ["--session-id", newSessionId]),
      prompt,
    ];
    const processResult = await runProcess(
      this.command,
      args,
      input.workingDirectory,
      input.signal,
      undefined,
      input.onProcessStart,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(processResult.stdout);
    } catch {
      payload = processResult.stdout;
    }
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const metrics = extractMetrics(record);
    if (record.is_error === true) {
      throw new ProviderRunError(
        `Claude failed: ${String(record.result ?? "unknown error")}`,
        metrics,
      );
    }
    return {
      result: parseAgentResult(payload),
      sessionId: typeof record.session_id === "string" ? record.session_id : newSessionId,
      rawOutput: processResult.stdout,
      metrics,
    };
  }
}

function extractMetrics(record: Record<string, unknown>): JobMetrics | undefined {
  const costUsd = asNonNegativeNumber(record.total_cost_usd);
  const usage = asTokenUsage(record.usage);
  return costUsd === undefined && !usage ? undefined : { costUsd, usage };
}

function asTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = asNonNegativeNumber(record.input_tokens) ?? 0;
  const cachedInputTokens = asNonNegativeNumber(record.cached_input_tokens) ?? 0;
  const outputTokens = asNonNegativeNumber(record.output_tokens) ?? 0;
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens };
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
