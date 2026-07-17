import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteAttachment } from "./types.js";
import type { TelegramClient, TelegramFileReference, TelegramMessage } from "./telegram.js";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function safeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "input.bin";
}

export function extractRemoteAttachments(message: TelegramMessage): RemoteAttachment[] {
  if (message.document) {
    return [remoteAttachment(message.document, "input.bin")];
  }

  if (message.photo?.length) {
    const photo = message.photo.at(-1)!;
    return [remoteAttachment(photo, "input.jpg", "image/jpeg")];
  }
  if (message.animation) return [remoteAttachment(message.animation, "input.gif", "image/gif")];
  if (message.audio) return [remoteAttachment(message.audio, "input.audio", "audio/*")];
  if (message.video) return [remoteAttachment(message.video, "input.mp4", "video/mp4")];
  if (message.voice) return [remoteAttachment(message.voice, "input.ogg", "audio/ogg")];
  if (message.video_note) return [remoteAttachment(message.video_note, "input.mp4", "video/mp4")];
  if (message.sticker) {
    const suffix = message.sticker.is_video ? "webm" : message.sticker.is_animated ? "tgs" : "webp";
    return [remoteAttachment(message.sticker, `input.${suffix}`, "application/octet-stream")];
  }
  return [];
}

function remoteAttachment(
  file: TelegramFileReference,
  fallbackName: string,
  fallbackMime = "application/octet-stream",
): RemoteAttachment {
  const fileSize = file.file_size ?? 0;
  if (fileSize > MAX_DOWNLOAD_BYTES) {
    throw new Error("The attachment exceeds Telegram's 20 MB bot download limit.");
  }
  return {
    fileId: file.file_id,
    fileName: safeFileName(file.file_name ?? fallbackName),
    mimeType: file.mime_type ?? fallbackMime,
    fileSize,
  };
}

export async function downloadAttachments(
  telegram: TelegramClient,
  attachments: RemoteAttachment[],
  jobDir: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const destination = path.join(jobDir, "input", `${index + 1}-${safeFileName(attachment.fileName)}`);
    await telegram.downloadFile(attachment.fileId, destination);
    paths.push(destination);
  }
  return paths;
}

export async function validateOutboundAttachment(
  inputPath: string,
  workingDirectory: string,
): Promise<string> {
  const expanded = inputPath.startsWith("~/")
    ? path.join(process.env.HOME ?? workingDirectory, inputPath.slice(2))
    : inputPath;
  const resolved = path.resolve(workingDirectory, expanded);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${resolved}`);
  if (stat.size > 50 * 1024 * 1024) throw new Error(`Attachment exceeds 50 MB: ${resolved}`);
  return resolved;
}
