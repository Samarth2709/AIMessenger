import type { AgentResult, JobMetrics, ProviderName } from "../types.js";
import type { AgentSkill } from "../skills.js";
import type { MemoryPromptContext } from "../memory.js";

export interface ProviderRunInput {
  identity: string;
  skills: AgentSkill[];
  provider: ProviderName;
  model?: string;
  prompt: string;
  conversationContext?: string;
  memory?: MemoryPromptContext;
  attachmentPaths: string[];
  imagePaths: string[];
  attachmentContext?: string;
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
  routing?: {
    requestedModel?: string;
    executedModel?: string;
    fallbackReason?: string;
  };
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
