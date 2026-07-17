import fs from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import { getDefaultEnvFile } from "../src/defaults.js";

const envFile = process.env.AIMESSENGER_ENV_FILE ?? getDefaultEnvFile(process.platform, process.env, os.homedir());
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });
else dotenv.config({ quiet: true });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error(`Set TELEGRAM_BOT_TOKEN in ${envFile} or the shell first.`);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ timeout: 0, limit: 100, allowed_updates: ["message"] }),
});
const payload = (await response.json()) as {
  ok: boolean;
  description?: string;
  result?: Array<{
    message?: { from?: { id: number; username?: string }; chat: { id: number; type: string } };
  }>;
};
if (!payload.ok) throw new Error(payload.description ?? "Telegram getUpdates failed.");

const users = new Map<number, { username?: string; chatId: number; chatType: string }>();
for (const update of payload.result ?? []) {
  const message = update.message;
  if (message?.from) {
    users.set(message.from.id, {
      username: message.from.username,
      chatId: message.chat.id,
      chatType: message.chat.type,
    });
  }
}

if (!users.size) {
  console.log("No messages found. Send /start to the bot in Telegram, then run this command again.");
} else {
  for (const [userId, info] of users) {
    console.log(
      `TELEGRAM_ALLOWED_USER_ID=${userId} username=${info.username ?? "unknown"} chat=${info.chatId} type=${info.chatType}`,
    );
  }
}
