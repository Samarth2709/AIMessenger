import fs from "node:fs/promises";
import path from "node:path";
import { chunkText } from "./chunk.js";

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

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; username?: string };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
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

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.telegram.org",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private endpoint(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown> | FormData,
    signal?: AbortSignal,
    retry = true,
  ): Promise<T> {
    const multipart = body instanceof FormData;
    const response = await this.fetchImpl(this.endpoint(method), {
      method: "POST",
      headers: multipart ? undefined : { "content-type": "application/json" },
      body: multipart ? body : JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!payload.ok || payload.result === undefined) {
      const retryAfter = payload.parameters?.retry_after;
      if (retry && retryAfter && retryAfter <= 30) {
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return this.call(method, body, signal, false);
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
        { command: "stop", description: "Cancel the running job" },
        { command: "new", description: "Reset a provider session" },
        { command: "retry", description: "Retry a stopped or failed job" },
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
    );
  }

  async sendText(chatId: number, text: string, jobId?: number): Promise<number[]> {
    const chunks = chunkText(text);
    const ids: number[] = [];
    for (const chunk of chunks) {
      const message = await this.call<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: chunk,
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
    const response = await this.fetchImpl(
      `${this.apiBase}/file/bot${this.token}/${remote.file_path}`,
    );
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
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    form.set("document", new Blob([bytes]), path.basename(filePath));
    const message = await this.call<TelegramMessage>("sendDocument", form);
    return message.message_id;
  }
}
