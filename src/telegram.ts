import fs from "node:fs/promises";
import path from "node:path";
import { chunkText } from "./chunk.js";
import { formatTelegramText } from "./telegram-format.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const LONG_POLL_TIMEOUT_MS = 45_000;
const FILE_TRANSFER_TIMEOUT_MS = 120_000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramFileReference {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; username?: string };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  document?: TelegramFileReference;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  animation?: TelegramFileReference;
  audio?: TelegramFileReference;
  video?: TelegramFileReference;
  voice?: TelegramFileReference;
  video_note?: TelegramFileReference;
  sticker?: TelegramFileReference & { is_animated?: boolean; is_video?: boolean };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class TelegramRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Telegram ${method} timed out after ${timeoutMs} ms.`);
    this.name = "TelegramRequestTimeoutError";
  }
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.telegram.org",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  private endpoint(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown> | FormData,
    signal?: AbortSignal,
    retry = true,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    const multipart = body instanceof FormData;
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(method), {
        method: "POST",
        headers: multipart ? undefined : { "content-type": "application/json" },
        body: multipart ? body : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new TelegramRequestTimeoutError(method, timeoutMs);
      throw error;
    }
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!payload.ok || payload.result === undefined) {
      const retryAfter = payload.parameters?.retry_after;
      if (retry && retryAfter && retryAfter <= 30) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return this.call(method, body, signal, false, timeoutMs);
      }
      throw new TelegramApiError(
        payload.description ?? `Telegram API ${method} failed with HTTP ${response.status}`,
        payload.error_code,
      );
    }
    return payload.result;
  }

  async initialize(): Promise<{ id: number; username?: string }> {
    await this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
    const me = await this.call<{ id: number; username?: string }>("getMe", {});
    await this.call<boolean>("setMyCommands", {
      commands: [
        { command: "codex", description: "Use Codex for new messages" },
        { command: "claude", description: "Use Claude for new messages" },
        { command: "status", description: "Show current job and queue" },
        { command: "model", description: "Choose a Codex or gateway model" },
        { command: "updates", description: "Show self-update status" },
        { command: "rollback", description: "Restore the previous release" },
        { command: "cost", description: "Show provider-reported spend" },
        { command: "stop", description: "Cancel the running job" },
        { command: "new", description: "Reset a provider session" },
        { command: "retry", description: "Retry a stopped or failed job" },
        { command: "skills", description: "List reusable workflows" },
        { command: "help", description: "Show command help" },
      ],
    });
    return me;
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: 30, allowed_updates: ["message"] },
      signal,
      true,
      LONG_POLL_TIMEOUT_MS,
    );
  }

  async sendText(chatId: number, text: string, jobId?: number): Promise<number[]> {
    const chunks = chunkText(text);
    const ids: number[] = [];
    for (const chunk of chunks) {
      const message = await this.call<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: formatTelegramText(chunk),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      ids.push(message.message_id);
    }
    return ids;
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.call<boolean>("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id: fileId });
  }

  async downloadFile(fileId: string, destination: string): Promise<void> {
    const remote = await this.getFile(fileId);
    if (!remote.file_path) throw new Error("Telegram did not return a file path.");
    const timeout = AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBase}/file/bot${this.token}/${remote.file_path}`,
        { signal: timeout },
      );
    } catch (error) {
      if (timeout.aborted) throw new TelegramRequestTimeoutError("downloadFile", FILE_TRANSFER_TIMEOUT_MS);
      throw error;
    }
    if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("Telegram input exceeds the 20 MB Bot API download limit.");
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { mode: 0o600 });
  }

  async sendFile(chatId: number, filePath: string, caption?: string): Promise<number> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${filePath}`);
    if (stat.size > 50 * 1024 * 1024) {
      throw new Error(`Attachment exceeds Telegram's 50 MB upload limit: ${filePath}`);
    }

    const bytes = await fs.readFile(filePath);
    if (isPhoto(filePath) && stat.size <= MAX_PHOTO_BYTES) {
      try {
        return await this.sendMultipart("sendPhoto", "photo", chatId, bytes, filePath, caption);
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.code !== 400) throw error;
      }
    }
    return this.sendMultipart("sendDocument", "document", chatId, bytes, filePath, caption);
  }

  private async sendMultipart(
    method: "sendDocument" | "sendPhoto",
    field: "document" | "photo",
    chatId: number,
    bytes: Buffer,
    filePath: string,
    caption?: string,
  ): Promise<number> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    form.set(field, new Blob([blobBytes.buffer]), path.basename(filePath));
    const message = await this.call<TelegramMessage>(method, form, undefined, true, FILE_TRANSFER_TIMEOUT_MS);
    return message.message_id;
  }
}

function isPhoto(filePath: string): boolean {
  return [".jpg", ".jpeg", ".png"].includes(path.extname(filePath).toLowerCase());
}
