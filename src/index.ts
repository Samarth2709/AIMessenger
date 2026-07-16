import http from "node:http";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import { TelegramAgentService } from "./service.js";
import { TelegramClient } from "./telegram.js";
import { JobWorker } from "./worker.js";

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  fs.mkdirSync(config.AIMESSENGER_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.AIMESSENGER_DATA_DIR, 0o700);
  fs.mkdirSync(config.jobsDir, { recursive: true, mode: 0o700 });
  const db = new AppDatabase(config.databasePath);
  const telegram = new TelegramClient(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_API_BASE);
  const worker = new JobWorker(
    db,
    telegram,
    {
      codex: new CodexProvider(config.CODEX_COMMAND),
      claude: new ClaudeProvider(config.CLAUDE_COMMAND),
    },
    config,
  );
  const service = new TelegramAgentService(db, telegram, worker, config);

  await service.start();
  const health = http.createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    const status = db.status();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        activeProvider: db.getActiveProvider(config.DEFAULT_PROVIDER),
        runningJob: status.running?.id ?? null,
        queued: status.queued,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(config.AIMESSENGER_PORT, "127.0.0.1", () => {
      health.off("error", reject);
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    health.close();
    await service.shutdown();
    db.close();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
