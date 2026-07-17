import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./types.js";
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
      input.context,
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
    if (record.is_error === true) {
      throw new Error(`Claude failed: ${String(record.result ?? "unknown error")}`);
    }
    return {
      result: parseAgentResult(payload),
      sessionId: typeof record.session_id === "string" ? record.session_id : newSessionId,
      rawOutput: processResult.stdout,
    };
  }
}
