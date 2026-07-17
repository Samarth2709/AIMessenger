import type { AgentResult, ProviderName } from "../types.js";
import type { AgentSkill } from "../skills.js";

export interface ProviderRunInput {
  identity: string;
  skills: AgentSkill[];
  provider: ProviderName;
  model?: string;
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
}

export interface AgentProvider {
  run(input: ProviderRunInput): Promise<ProviderRunOutput>;
}
