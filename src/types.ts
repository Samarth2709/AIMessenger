export type ProviderName = "codex" | "claude";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

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
}

export interface JobRow {
  id: number;
  update_id: number;
  telegram_message_id: number;
  chat_id: number;
  user_message_id: number;
  provider: ProviderName;
  prompt: string;
  attachments_json: string;
  status: JobStatus;
  retry_of: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result_text: string | null;
  process_pid: number | null;
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
