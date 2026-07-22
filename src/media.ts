import { createHash } from "node:crypto";
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

export async function inspectDownloadedAttachments(
  attachments: RemoteAttachment[],
  attachmentPaths: string[],
): Promise<Array<{
  declaredMimeType: string;
  detectedMimeType: string;
  declaredBytes: number;
  actualBytes: number;
  sha256: string;
  imageHeaderValid: boolean;
  imageDimensions?: string;
}>> {
  if (attachments.length !== attachmentPaths.length) {
    throw new Error("Downloaded attachment count did not match the queued attachment count.");
  }
  return Promise.all(attachments.map(async (attachment, index) => {
    const bytes = await fs.readFile(attachmentPaths[index]!);
    const image = inspectImageHeader(bytes);
    return {
      declaredMimeType: attachment.mimeType,
      detectedMimeType: image.mimeType,
      declaredBytes: attachment.fileSize,
      actualBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      imageHeaderValid: image.valid,
      ...(image.dimensions ? { imageDimensions: image.dimensions } : {}),
    };
  }));
}

function inspectImageHeader(bytes: Buffer): {
  mimeType: string;
  valid: boolean;
  dimensions?: string;
} {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return imageHeader("image/png", width, height, bytes.subarray(12, 16).equals(Buffer.from("IHDR")));
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).equals(Buffer.from("GIF"))) {
    return imageHeader("image/gif", bytes.readUInt16LE(6), bytes.readUInt16LE(8), bytes.length >= 10);
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return inspectJpegHeader(bytes);
  if (bytes.length >= 16 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    bytes.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return { mimeType: "image/webp", valid: bytes.length >= 16 };
  }
  return { mimeType: "unknown", valid: false };
}

function inspectJpegHeader(bytes: Buffer): { mimeType: string; valid: boolean; dimensions?: string } {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return { mimeType: "image/jpeg", valid: false };
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return imageHeader("image/jpeg", bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), length >= 8);
    }
    offset += length;
  }
  return { mimeType: "image/jpeg", valid: false };
}

function imageHeader(mimeType: string, width: number, height: number, valid: boolean): {
  mimeType: string;
  valid: boolean;
  dimensions?: string;
} {
  return valid && width > 0 && height > 0
    ? { mimeType, valid: true, dimensions: `${width}x${height}` }
    : { mimeType, valid: false };
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
