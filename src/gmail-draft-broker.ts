import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createGmailDraft,
  type GmailDraftRequest,
  type GmailDraftResult,
  GmailDraftError,
  validateGmailDraftRequest,
} from "./gmail-drafts.js";

const MAX_REQUEST_BYTES = 1024 * 1024 + 16 * 1024;

export interface BrokerConfig {
  dataDir: string;
  port: number;
  clientKey: string;
}

async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<BrokerConfig> {
  const dataDir = env.AIMESSENGER_MAIL_DATA_DIR ?? "/var/lib/aimessenger-mail";
  if (!path.isAbsolute(dataDir)) throw new Error("AIMESSENGER_MAIL_DATA_DIR must be absolute.");
  const port = Number(env.AIMESSENGER_MAIL_PORT ?? "8791");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AIMESSENGER_MAIL_PORT must be a valid TCP port.");
  }
  const clientKeyFile = env.AIMESSENGER_MAIL_CLIENT_KEY_FILE ?? "/etc/aimessenger-mail/client.key";
  let clientKey: string;
  try {
    clientKey = (await fs.readFile(clientKeyFile, "utf8")).trim();
  } catch {
    throw new Error("Cannot read the Gmail broker client key.");
  }
  if (clientKey.length < 32) throw new Error("The Gmail broker client key is invalid.");
  return { dataDir, port, clientKey };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_REQUEST_BYTES) throw new GmailDraftError("Draft request is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GmailDraftError("Draft request must be valid JSON.");
  }
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export function clientKeyMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const received = Buffer.from(provided, "utf8");
  const target = Buffer.from(expected, "utf8");
  return received.length === target.length && crypto.timingSafeEqual(received, target);
}

export function createBroker(
  config: BrokerConfig,
  createDraft: (dataDir: string, draft: GmailDraftRequest) => Promise<GmailDraftResult> = createGmailDraft,
): http.Server {
  return http.createServer((request, response) => {
    void (async () => {
      if (!isLoopback(request.socket.remoteAddress)) {
        json(response, 403, { error: "loopback access only" });
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        json(response, 200, { ok: true, mode: "draft-only" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/drafts") {
        json(response, 404, { error: "not found" });
        return;
      }
      const suppliedKey = request.headers["x-aimessenger-mail-key"];
      if (Array.isArray(suppliedKey) || !clientKeyMatches(suppliedKey, config.clientKey)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const draft = validateGmailDraftRequest(await readJson(request));
        const result = await createDraft(config.dataDir, draft);
        console.info("gmail_draft_created", { account: draft.account, recipient_count: draft.to.length + draft.cc.length + draft.bcc.length });
        json(response, 201, { account: draft.account, draftId: result.draftId, messageId: result.messageId });
      } catch (error) {
        const message = error instanceof GmailDraftError ? error.message : "Draft creation failed.";
        console.error("gmail_draft_failed", { message });
        json(response, 400, { error: message });
      }
    })();
  });
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("The Gmail draft broker must not run as root.");
  }
  process.umask(0o077);
  const config = await loadConfig();
  const server = createBroker(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.info("gmail_draft_broker_listening", { port: config.port, mode: "draft-only" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
