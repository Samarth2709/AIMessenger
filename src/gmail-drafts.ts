import fs from "node:fs/promises";
import path from "node:path";

export const GMAIL_DRAFT_ACCOUNTS = [
  "samarth.kumbla@gmail.com",
  "sk5335@columbia.edu",
] as const;

export type GmailDraftAccount = (typeof GMAIL_DRAFT_ACCOUNTS)[number];

export interface GmailDraftRequest {
  account: GmailDraftAccount;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface GmailOAuthClient {
  clientId: string;
  clientSecret?: string;
  tokenUri: string;
}

interface GmailToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
}

export interface GmailDraftResult {
  draftId: string;
  messageId: string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponse>;

const EMAIL_ADDRESS = /^[^\s@<>()\[\]\\,;:]+@[^\s@<>()\[\]\\,;:]+$/;
const MAX_RECIPIENTS = 100;
const MAX_SUBJECT_BYTES = 4 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

export class GmailDraftError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGmailDraftAccount(value: string): value is GmailDraftAccount {
  return (GMAIL_DRAFT_ACCOUNTS as readonly string[]).includes(value);
}

function readString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new GmailDraftError(`${field} must be a string.`);
  if (!allowEmpty && !value.trim()) throw new GmailDraftError(`${field} must not be empty.`);
  return value;
}

function rejectHeaderInjection(value: string, field: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new GmailDraftError(`${field} must not contain line breaks.`);
  }
}

function readRecipients(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GmailDraftError(`${field} must be an array of email addresses.`);
  if (value.length > MAX_RECIPIENTS) throw new GmailDraftError(`${field} has too many recipients.`);
  return value.map((item) => {
    const address = readString(item, field).trim();
    rejectHeaderInjection(address, field);
    if (!EMAIL_ADDRESS.test(address)) {
      throw new GmailDraftError(`${field} contains an invalid email address.`);
    }
    return address;
  });
}

export function validateGmailDraftRequest(value: unknown): GmailDraftRequest {
  if (!isRecord(value)) throw new GmailDraftError("Draft payload must be a JSON object.");
  const account = readString(value.account, "account").trim();
  if (!isGmailDraftAccount(account)) {
    throw new GmailDraftError("account is not enabled for Gmail drafts.");
  }
  const to = readRecipients(value.to, "to");
  const cc = readRecipients(value.cc, "cc");
  const bcc = readRecipients(value.bcc, "bcc");
  if (to.length + cc.length + bcc.length === 0) {
    throw new GmailDraftError("At least one recipient is required.");
  }
  const subject = readString(value.subject, "subject", true);
  rejectHeaderInjection(subject, "subject");
  if (Buffer.byteLength(subject) > MAX_SUBJECT_BYTES) {
    throw new GmailDraftError("subject is too long.");
  }
  const body = readString(value.body, "body", true);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new GmailDraftError("body is too long.");
  return { account, to, cc, bcc, subject, body };
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function encodeBody(body: string): string {
  const normalized = body.replace(/\r?\n/g, "\r\n");
  const encoded = Buffer.from(normalized, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export function buildGmailDraftMime(draft: GmailDraftRequest): string {
  const headers = [
    `To: ${draft.to.join(", ")}`,
    ...(draft.cc.length ? [`Cc: ${draft.cc.join(", ")}`] : []),
    ...(draft.bcc.length ? [`Bcc: ${draft.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${encodeBody(draft.body)}\r\n`;
}

function tokenName(account: GmailDraftAccount): string {
  return account === "samarth.kumbla@gmail.com" ? "samarth-kumbla-gmail" : "sk5335-columbia";
}

export function gmailTokenPath(dataDir: string, account: GmailDraftAccount): string {
  return path.join(dataDir, `${tokenName(account)}.token.json`);
}

export function oauthClientPath(dataDir: string): string {
  return path.join(dataDir, "oauth-client.json");
}

export async function loadGmailOAuthClient(file: string): Promise<GmailOAuthClient> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new GmailDraftError(`Cannot read OAuth client file: ${file}`);
  }
  if (!isRecord(raw)) throw new GmailDraftError("OAuth client file must contain an object.");
  const client = isRecord(raw.installed) ? raw.installed : isRecord(raw.web) ? raw.web : undefined;
  if (!client) throw new GmailDraftError("OAuth client file must contain installed client credentials.");
  const clientId = readString(client.client_id, "oauth client_id");
  const clientSecret = typeof client.client_secret === "string" ? client.client_secret : undefined;
  const tokenUri = typeof client.token_uri === "string" ? client.token_uri : "https://oauth2.googleapis.com/token";
  try {
    new URL(tokenUri);
  } catch {
    throw new GmailDraftError("OAuth token URI is invalid.");
  }
  return { clientId, clientSecret, tokenUri };
}

async function loadToken(file: string): Promise<GmailToken> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new GmailDraftError("This Gmail account has not been authorized yet.");
  }
  if (!isRecord(raw) || typeof raw.access_token !== "string" || typeof raw.refresh_token !== "string" || typeof raw.expires_at !== "number") {
    throw new GmailDraftError("Stored Gmail authorization is invalid. Authorize the account again.");
  }
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
    ...(typeof raw.token_type === "string" ? { token_type: raw.token_type } : {}),
  };
}

export async function saveGmailToken(file: string, token: GmailToken): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(token)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}

async function fetchJson(response: FetchResponse, action: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.text();
    throw new GmailDraftError(`Gmail ${action} failed (HTTP ${response.status}).`);
  }
  const value = await response.json();
  if (!isRecord(value)) throw new GmailDraftError(`Gmail ${action} returned an invalid response.`);
  return value;
}

export async function exchangeAuthorizationCode(
  client: GmailOAuthClient,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<GmailToken> {
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const value = await fetchJson(
    await fetchImpl(client.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    "OAuth authorization",
  );
  if (typeof value.access_token !== "string" || typeof value.refresh_token !== "string") {
    throw new GmailDraftError("OAuth authorization did not return a refresh token.");
  }
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 3600;
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.token_type === "string" ? { token_type: value.token_type } : {}),
  };
}

async function refreshToken(
  client: GmailOAuthClient,
  current: GmailToken,
  fetchImpl: FetchLike,
): Promise<GmailToken> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const value = await fetchJson(
    await fetchImpl(client.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    "OAuth refresh",
  );
  if (typeof value.access_token !== "string") {
    throw new GmailDraftError("OAuth refresh did not return an access token.");
  }
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 3600;
  return {
    ...current,
    access_token: value.access_token,
    expires_at: Date.now() + expiresIn * 1000,
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.token_type === "string" ? { token_type: value.token_type } : {}),
  };
}

export async function getGmailProfileEmail(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const value = await fetchJson(
    await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    "profile lookup",
  );
  if (typeof value.emailAddress !== "string") {
    throw new GmailDraftError("Gmail profile lookup did not return an email address.");
  }
  return value.emailAddress.toLowerCase();
}

export async function createGmailDraft(
  dataDir: string,
  draft: GmailDraftRequest,
  fetchImpl: FetchLike = fetch,
): Promise<GmailDraftResult> {
  const client = await loadGmailOAuthClient(oauthClientPath(dataDir));
  const file = gmailTokenPath(dataDir, draft.account);
  let token = await loadToken(file);
  if (token.expires_at <= Date.now() + 60_000) {
    token = await refreshToken(client, token, fetchImpl);
    await saveGmailToken(file, token);
  }
  const profileEmail = await getGmailProfileEmail(token.access_token, fetchImpl);
  if (profileEmail !== draft.account) {
    throw new GmailDraftError("Stored Gmail authorization does not match the requested account.");
  }
  const raw = Buffer.from(buildGmailDraftMime(draft), "utf8").toString("base64url");
  const value = await fetchJson(
    await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    }),
    "draft creation",
  );
  const message = isRecord(value.message) ? value.message : undefined;
  if (typeof value.id !== "string" || !message || typeof message.id !== "string") {
    throw new GmailDraftError("Gmail draft creation returned an invalid response.");
  }
  return { draftId: value.id, messageId: message.id };
}
