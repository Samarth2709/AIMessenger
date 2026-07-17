import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import {
  exchangeAuthorizationCode,
  GMAIL_DRAFT_ACCOUNTS,
  getGmailProfileEmail,
  gmailTokenPath,
  loadGmailOAuthClient,
  oauthClientPath,
  saveGmailToken,
  type GmailDraftAccount,
} from "../src/gmail-drafts.js";

const CALLBACK_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.compose";

function usage(): never {
  console.error("Usage: gmail-authorize --account samarth.kumbla@gmail.com|sk5335@columbia.edu");
  process.exit(2);
}

function accountFromArgs(args: string[]): GmailDraftAccount {
  if (args.length !== 2 || args[0] !== "--account") usage();
  const account = args[1];
  if (!(GMAIL_DRAFT_ACCOUNTS as readonly string[]).includes(account ?? "")) usage();
  return account as GmailDraftAccount;
}

async function receiveAuthorizationCode(state: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth authorization timed out after 10 minutes.")), 10 * 60_000);
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", REDIRECT_URI);
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization did not match this request. You may close this tab.");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Gmail authorization completed. Return to your terminal.");
      clearTimeout(timer);
      server.close(() => resolve(code));
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  process.umask(0o077);
  const account = accountFromArgs(process.argv.slice(2));
  const dataDir = process.env.AIMESSENGER_MAIL_DATA_DIR ?? "/var/lib/aimessenger-mail";
  if (!path.isAbsolute(dataDir)) throw new Error("AIMESSENGER_MAIL_DATA_DIR must be absolute.");
  const client = await loadGmailOAuthClient(oauthClientPath(dataDir));
  const state = crypto.randomBytes(32).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  const waitForCode = receiveAuthorizationCode(state);
  console.log(`Open this URL in your browser to authorize ${account}:\n${url.toString()}\n`);
  const code = await waitForCode;
  const token = await exchangeAuthorizationCode(client, code, REDIRECT_URI);
  const authorizedEmail = await getGmailProfileEmail(token.access_token);
  if (authorizedEmail !== account) {
    throw new Error(`Authorized ${authorizedEmail}, but expected ${account}. No token was saved.`);
  }
  await saveGmailToken(gmailTokenPath(dataDir, account), token);
  console.log(`Authorized draft creation for ${account}. No email was sent.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
