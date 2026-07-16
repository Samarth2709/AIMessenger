import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./types.js";
import { buildPrompt, parseAgentResult } from "./structured.js";
import { runProcess } from "./process.js";

export class CodexProvider implements AgentProvider {
  constructor(private readonly command = "codex") {}

  async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    const prompt = buildPrompt(input.prompt, input.context, input.attachmentPaths);
    const shared = [
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-schema",
      input.schemaPath,
    ];
    const args = input.sessionId
      ? ["exec", "resume", ...shared, input.sessionId, prompt]
      : ["exec", ...shared, "-C", input.workingDirectory, prompt];
    let streamedSessionId = input.sessionId;
    let streamBuffer = "";
    const processResult = await runProcess(
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
    );

    let sessionId = streamedSessionId;
    let finalText = "";
    let errorMessage = "";
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
        if (event.type === "error" && typeof event.message === "string") errorMessage = event.message;
      } catch {
        // Codex emits JSONL; ignore non-event diagnostic lines.
      }
    }
    if (!finalText && errorMessage) throw new Error(`Codex failed: ${errorMessage}`);
    return {
      result: parseAgentResult(finalText, finalText),
      sessionId,
      rawOutput: processResult.stdout,
    };
  }
}
