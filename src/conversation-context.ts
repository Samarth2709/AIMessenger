import type { AppDatabase } from "./db.js";
import type { JobRow } from "./types.js";

const MAX_CONTEXT_ENTRIES = 6;
const MAX_ENTRY_CHARS = 1_200;
const MAX_FOLLOWUP_REQUEST_CHARS = 4_000;

const FOLLOWUP_PATTERN = /\b(?:this|that|these|it|them|those|above|previous|prior|instead|also|continue|complete|finish|resume|back|more)\b/i;
const MEDIA_AUDIT_PATTERN = /\b(?:image|images|file|files|attachment|attachments)\b/i;
const MEDIA_REFERENCE_PATTERN = /\b(?:sent|send|generate|generated|create|created|download|downloaded|online|source|where)\b/i;

export interface ConversationContextDecision {
  context?: string;
  reason:
    | "empty_request"
    | "request_too_long"
    | "not_referential"
    | "no_prior_history"
    | "history_unavailable"
    | "included";
  referenceCount: number;
  mediaReferenceCount: number;
}

function isMediaAuditRequest(prompt: string): boolean {
  return MEDIA_AUDIT_PATTERN.test(prompt) && MEDIA_REFERENCE_PATTERN.test(prompt);
}

export function isFollowupRequest(prompt: string): boolean {
  const normalized = prompt.trim();
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_FOLLOWUP_REQUEST_CHARS &&
    (FOLLOWUP_PATTERN.test(normalized) ||
      isMediaAuditRequest(normalized))
  );
}

export function decideConversationContext(db: AppDatabase, job: JobRow): ConversationContextDecision {
  const normalized = job.prompt.trim();
  if (!normalized) return { reason: "empty_request", referenceCount: 0, mediaReferenceCount: 0 };
  if (normalized.length > MAX_FOLLOWUP_REQUEST_CHARS) {
    return { reason: "request_too_long", referenceCount: 0, mediaReferenceCount: 0 };
  }
  if (!isFollowupRequest(normalized)) {
    return { reason: "not_referential", referenceCount: 0, mediaReferenceCount: 0 };
  }
  const referenceIds = db
    .recentHistory(job.chat_id, MAX_CONTEXT_ENTRIES, job.user_message_id)
    .map((entry) => entry.id);
  let mediaReferenceCount = 0;
  if (isMediaAuditRequest(job.prompt)) {
    for (const mediaId of db.recentHistoryWithMedia(
      job.chat_id,
      MAX_CONTEXT_ENTRIES,
      job.user_message_id,
    )) {
      if (!referenceIds.includes(mediaId)) {
        referenceIds.push(mediaId);
        mediaReferenceCount += 1;
      }
    }
  }
  if (!referenceIds.length) {
    return { reason: "no_prior_history", referenceCount: 0, mediaReferenceCount };
  }
  referenceIds.sort((left, right) => left - right);
  const entries = db.readHistory(
    referenceIds,
    job.chat_id,
    MAX_ENTRY_CHARS,
  );
  if (!entries.length) {
    return { reason: "history_unavailable", referenceCount: referenceIds.length, mediaReferenceCount };
  }
  return {
    reason: "included",
    referenceCount: entries.length,
    mediaReferenceCount,
    context: entries
      .map((entry) => {
        const media = entry.attachments.map((attachment) => {
          const mediaType = attachment.mediaType.startsWith("image/") ? "image" : "file";
          const label = attachment.caption ?? attachment.fileName;
          const origin = attachment.provenance === "web"
            ? `web${attachment.sourceUrl ? ` ${attachment.sourceUrl}` : ""}`
            : attachment.provenance;
          return `[delivery] ${attachment.deliveryStatus} ${mediaType} “${label}” (origin: ${origin})`;
        });
        return [
          `[${entry.role}] ${entry.content}${entry.truncated ? " …" : ""}`,
          ...media,
        ].join("\n");
      })
      .join("\n\n"),
  };
}

export function buildConversationContext(db: AppDatabase, job: JobRow): string | undefined {
  return decideConversationContext(db, job).context;
}
