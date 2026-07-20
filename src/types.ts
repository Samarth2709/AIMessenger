export type ProviderName = "codex" | "claude";

// Stored instead of a native session ID for providers that need full transcript context each turn.
export const STATELESS_SESSION_ID = "__aimessenger_stateless__";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export type JobMode = "normal" | "deep_research";

export interface RemoteAttachment {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface AgentAttachment {
  path: string;
  caption?: string;
}

export interface AgentResult {
  message: string;
  attachments: AgentAttachment[];
  sessionDisposition?: "continue" | "handoff";
  memoryRefs?: string[];
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface JobMetrics {
  model?: string;
  requestedModel?: string;
  fallbackReason?: string;
  costUsd?: number;
  codexCredits?: number;
  usage?: TokenUsage;
}

export interface CostProviderSummary {
  jobs: number;
  pricedJobs: number;
  costUsd: number;
  creditedJobs: number;
  codexCredits: number;
  usage: TokenUsage;
}

export interface CostSummary {
  jobs: number;
  pricedJobs: number;
  costUsd: number;
  creditedJobs: number;
  codexCredits: number;
  providers: Record<ProviderName, CostProviderSummary>;
}

export interface JobRow {
  id: number;
  update_id: number;
  telegram_message_id: number;
  chat_id: number;
  user_message_id: number;
  provider: ProviderName;
  prompt: string;
  mode: JobMode;
  attachments_json: string;
  status: JobStatus;
  retry_of: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result_text: string | null;
  process_pid: number | null;
  model: string | null;
  requested_model: string | null;
  fallback_reason: string | null;
  cost_usd: number | null;
  cost_credits: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  usage_recorded_at: string | null;
  created_at: string;
}

export interface ProviderSessionRow {
  provider: ProviderName;
  session_id: string | null;
  last_message_id: number;
  tainted: number;
}

export interface OutboxRow {
  id: number;
  job_id: number;
  chat_id: number;
  kind: "text" | "document";
  payload_json: string;
  status: "pending" | "sending" | "sent";
  attempts: number;
  available_at: string;
  last_error: string | null;
  telegram_message_id: number | null;
  created_at: string;
  sent_at: string | null;
}

export interface OutboxInput {
  chatId: number;
  kind: "text" | "document";
  payload: { text: string } | { path: string; caption?: string };
}

export type LiveConversationState = "idle" | "starting" | "running";

export interface LiveConversationRow {
  chat_id: number;
  state: LiveConversationState;
  thread_id: string | null;
  active_turn_id: string | null;
  active_job_id: number | null;
  model: string | null;
  steering_count: number;
  created_at: string;
  updated_at: string;
}

export interface LiveSteerRow {
  id: number;
  chat_id: number;
  update_id: number;
  telegram_message_id: number;
  transcript_id: number;
  prompt: string;
  created_at: string;
}
