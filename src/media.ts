import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteAttachment } from "./types.js";
import type { TelegramClient, TelegramMessage } from "./telegram.js";

const allowedExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".doc",
  ".docx",
  ".pptx",
  ".xls",
  ".xlsx",
  ".txt",
  ".csv",
]);

const extensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

function safeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "input.bin";
}

export function extractRemoteAttachments(message: TelegramMessage): RemoteAttachment[] {
  if (message.document) {
    const document = message.document;
    const extension = path.extname(document.file_name ?? "").toLowerCase();
    const inferred = extensionByMime[document.mime_type ?? ""];
    const selectedExtension = extension || inferred || "";
    if (!allowedExtensions.has(selectedExtension)) {
      throw new Error(`Unsupported document type: ${document.file_name ?? document.mime_type ?? "unknown"}`);
    }
    if ((document.file_size ?? 0) > 20 * 1024 * 1024) {
      throw new Error("The document exceeds Telegram's 20 MB bot download limit.");
    }
    return [
      {
        fileId: document.file_id,
        fileName: safeFileName(document.file_name ?? `input${selectedExtension}`),
        mimeType: document.mime_type ?? "application/octet-stream",
        fileSize: document.file_size ?? 0,
      },
    ];
  }

  if (message.photo?.length) {
    const photo = message.photo.at(-1)!;
    return [
      {
        fileId: photo.file_id,
        fileName: "input.jpg",
        mimeType: "image/jpeg",
        fileSize: photo.file_size ?? 0,
      },
    ];
  }
  return [];
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
  const extension = path.extname(resolved).toLowerCase();
  if (!allowedExtensions.has(extension)) throw new Error(`Unsupported attachment type: ${extension}`);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${resolved}`);
  if (stat.size > 50 * 1024 * 1024) throw new Error(`Attachment exceeds 50 MB: ${resolved}`);
  return resolved;
}
