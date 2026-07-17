import { STATELESS_SESSION_ID } from "../types.js";
import { buildPrompt, parseAgentResult } from "./structured.js";
import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./types.js";

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

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const error = (payload as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : fallback;
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
    const prompt = buildPrompt(
      input.identity,
      input.skills,
      input,
      input.prompt,
      input.context,
      input.attachmentPaths,
    );
    const response = await this.request(`${this.apiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: input.signal,
    });
    const rawOutput = await response.text();
    let payload: unknown = rawOutput;
    try {
      payload = JSON.parse(rawOutput);
    } catch {
      // Include the raw gateway response below when it is valid completion text.
    }
    if (!response.ok) {
      throw new Error(`AI Security gateway failed: ${errorMessage(payload, `HTTP ${response.status}`)}`);
    }
    const message = responseMessage(payload) || (typeof payload === "string" ? payload : "");
    return {
      result: parseAgentResult(message),
      sessionId: STATELESS_SESSION_ID,
      rawOutput,
    };
  }
}
