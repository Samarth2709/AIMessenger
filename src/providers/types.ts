import type { AgentResult } from "../types.js";

export interface ProviderRunInput {
  prompt: string;
  context: string;
  attachmentPaths: string[];
  sessionId: string | null;
  workingDirectory: string;
  schemaPath: string;
  signal: AbortSignal;
}

export interface ProviderRunOutput {
  result: AgentResult;
  sessionId: string | null;
  rawOutput: string;
}

export interface AgentProvider {
  run(input: ProviderRunInput): Promise<ProviderRunOutput>;
}
