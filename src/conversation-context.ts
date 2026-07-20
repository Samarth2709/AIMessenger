import type { AppDatabase } from "./db.js";
import type { JobRow } from "./types.js";

const MAX_CONTEXT_ENTRIES = 6;
const MAX_ENTRY_CHARS = 1_200;

const FOLLOWUP_PATTERN = /\b(?:this|that|it|them|those|above|previous|prior|instead|also|continue|complete|finish|resume|back|more)\b/i;

export function isFollowupRequest(prompt: string): boolean {
  const normalized = prompt.trim();
  return normalized.length > 0 && normalized.length <= 500 && FOLLOWUP_PATTERN.test(normalized);
}

export function buildConversationContext(db: AppDatabase, job: JobRow): string | undefined {
  if (!isFollowupRequest(job.prompt)) return undefined;
  const references = db.recentHistory(job.chat_id, MAX_CONTEXT_ENTRIES, job.user_message_id).reverse();
  if (!references.length) return undefined;
  const entries = db.readHistory(
    references.map((entry) => entry.id),
    job.chat_id,
    MAX_ENTRY_CHARS,
  );
  if (!entries.length) return undefined;
  return entries
    .map((entry) => `[${entry.role}] ${entry.content}${entry.truncated ? " …" : ""}`)
    .join("\n\n");
}
