import type { TokenUsage } from "../types.js";
import {
  ProviderRunError,
  type AgentProvider,
  type ProviderRunInput,
  type ProviderRunOutput,
} from "./types.js";
import { buildPrompt, parseAgentResult } from "./structured.js";
import { ProcessError, runProcess } from "./process.js";

export class CodexProvider implements AgentProvider {
  constructor(
    private readonly command = "codex",
    private readonly executionMode: "standard" | "research_read_only" = "standard",
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    const prompt = buildPrompt(
      input.identity,
      input.skills,
      input,
      input.prompt,
      input.memory,
      input.attachmentPaths,
      input.attachmentContext,
      input.conversationContext,
    );
    const shared = [
      "--json",
      ...(input.model ? ["--model", input.model] : []),
      ...input.imagePaths.flatMap((imagePath) => ["--image", imagePath]),
      "--ignore-user-config",
      "--skip-git-repo-check",
      ...(this.executionMode === "research_read_only"
        ? ["--sandbox", "read-only", "--ephemeral"]
        : ["--dangerously-bypass-approvals-and-sandbox"]),
      "--output-schema",
      input.schemaPath,
    ];
    const args = input.sessionId
      ? ["exec", "resume", ...shared, input.sessionId, prompt]
      : ["exec", ...shared, "-C", input.workingDirectory, prompt];
    let streamedSessionId = input.sessionId;
    let streamBuffer = "";
    let processResult: { stdout: string; stderr: string };
    try {
      processResult = await runProcess(
        this.command,
        args,
        input.workingDirectory,
        input.signal,
        (chunk) => {
          streamBuffer += chunk;
          const lines = streamBuffer.split("\n");
          streamBuffer = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (event.type === "thread.started" && typeof event.thread_id === "string") {
                streamedSessionId = event.thread_id;
              }
            } catch {
              // Ignore incomplete or diagnostic lines.
            }
          }
        },
        input.onProcessStart,
      );
    } catch (error) {
      if (error instanceof ProcessError && error.stderr.trim()) {
        throw new Error(`Codex failed: ${error.stderr.trim().slice(0, 1_000)}`);
      }
      throw error;
    }

    let sessionId = streamedSessionId;
    let finalText = "";
    let errorMessage = "";
    let usage: TokenUsage | undefined;
    for (const line of processResult.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          sessionId = event.thread_id;
        }
        if (event.type === "item.completed" && event.item && typeof event.item === "object") {
          const item = event.item as Record<string, unknown>;
          if (item.type === "agent_message" && typeof item.text === "string") finalText = item.text;
        }
        if (event.type === "turn.completed") usage = asTokenUsage(event.usage);
        if (event.type === "error" && typeof event.message === "string") errorMessage = event.message;
      } catch {
        // Codex emits JSONL; ignore non-event diagnostic lines.
      }
    }
    if (!finalText && errorMessage) {
      throw new ProviderRunError(`Codex failed: ${errorMessage}`, usage ? { usage } : undefined);
    }
    return {
      result: parseAgentResult(finalText),
      sessionId,
      rawOutput: processResult.stdout,
      metrics: usage ? { usage } : undefined,
    };
  }
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
