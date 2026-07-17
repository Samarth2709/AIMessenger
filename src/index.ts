import http from "node:http";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db.js";
import { JsonLogger } from "./logger.js";
import { LiveCodexConversationManager } from "./live-conversations.js";
import { CombinedModelCatalog, CliModelCatalog, GatewayModelCatalog } from "./models.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import { GatewayProvider } from "./providers/gateway.js";
import { ModelRoutedProvider } from "./providers/routed.js";
import { TelegramAgentService } from "./service.js";
import { readReleaseMetadata, SelfUpdateMonitor } from "./self-update.js";
import { TelegramClient } from "./telegram.js";
import { JobWorker } from "./worker.js";

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  fs.mkdirSync(config.AIMESSENGER_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.AIMESSENGER_DATA_DIR, 0o700);
  fs.mkdirSync(config.jobsDir, { recursive: true, mode: 0o700 });
  const logger = new JsonLogger(config.logsDir);
  logger.info("service.starting");
  const release = readReleaseMetadata(config.appRoot);
  const db = new AppDatabase(config.databasePath);
  const telegram = new TelegramClient(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_API_BASE);
  const gatewayModels = new Set(
    config.GATEWAY_MODELS.split(",").map((model) => model.trim()).filter(Boolean),
  );
  const gatewayProvider = new GatewayProvider(config.GATEWAY_API_BASE, config.GATEWAY_API_KEY);
  const worker = new JobWorker(
    db,
    telegram,
    {
      codex: new ModelRoutedProvider(
        new CodexProvider(config.CODEX_COMMAND),
        gatewayProvider,
        gatewayModels,
      ),
      claude: new ClaudeProvider(config.CLAUDE_COMMAND),
    },
    config,
    logger,
  );
  const liveCodex = new LiveCodexConversationManager(
    db,
    telegram,
    config,
    logger,
    () => worker.notify(),
  );
  const service = new TelegramAgentService(
    db,
    telegram,
    worker,
    config,
    logger,
    new CombinedModelCatalog([
      new CliModelCatalog(config.CODEX_COMMAND),
      new GatewayModelCatalog(config.GATEWAY_API_BASE, config.GATEWAY_API_KEY, gatewayModels),
    ]),
    liveCodex,
  );

  let telegramReady = false;
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
        telegramReady,
        activeProvider: db.getActiveProvider(config.DEFAULT_PROVIDER),
        releaseId: release.id,
        runningJob: status.running?.id ?? null,
        queued: status.queued,
      }),
    );
  });
  let shuttingDown = false;
  let selfUpdateMonitor: SelfUpdateMonitor | undefined;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    selfUpdateMonitor?.stop();
    logger.info("service.stopping", { signal });
    health.close();
    await service.shutdown();
    db.close();
    logger.info("service.stopped", { signal });
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(config.AIMESSENGER_PORT, "127.0.0.1", () => {
      health.off("error", reject);
      resolve();
    });
  });
  logger.info("health_server.listening", { port: config.AIMESSENGER_PORT });
  await service.start();
  if (shuttingDown) return;
  telegramReady = true;
  if (config.SELF_UPDATE_ENABLED) {
    selfUpdateMonitor = new SelfUpdateMonitor(
      config.AIMESSENGER_DATA_DIR,
      release.id,
      logger,
      async () => {
        const drained = await service.prepareForSelfUpdate(config.SELF_UPDATE_DRAIN_SECONDS * 1_000);
        logger.info("self_update.drain_finished", { drained });
        await shutdown("self-update");
        process.exit(0);
      },
    );
    selfUpdateMonitor.start();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
