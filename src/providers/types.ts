import type { AgentResult, JobMetrics } from "../types.js";

export interface ProviderRunInput {
  prompt: string;
  context: string;
  attachmentPaths: string[];
  sessionId: string | null;
  workingDirectory: string;
  schemaPath: string;
  signal: AbortSignal;
  onProcessStart?: (pid: number) => void;
}

export interface ProviderRunOutput {
  result: AgentResult;
  sessionId: string | null;
  rawOutput: string;
  metrics?: JobMetrics;
}

export class ProviderRunError extends Error {
  constructor(
    message: string,
    readonly metrics?: JobMetrics,
  ) {
    super(message);
  }
}

export interface AgentProvider {
  run(input: ProviderRunInput): Promise<ProviderRunOutput>;
}
