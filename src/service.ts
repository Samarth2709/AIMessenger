import { displayProviderModel, getProviderModel, isGatewayModel, type Config } from "./config.js";
import { HELP_TEXT, parseCommand } from "./commands.js";
import type { AppDatabase } from "./db.js";
import type { AppLogger } from "./logger.js";
import type { LiveCodexConversations } from "./live-conversations.js";
import { extractRemoteAttachments } from "./media.js";
import type { ModelCatalog, ModelOption } from "./models.js";
import { loadSkills } from "./skills.js";
import {
  formatSelfUpdateStatus,
  readReleaseMetadata,
  readSelfUpdateState,
  rollbackRelease,
  startReleaseWatchdog,
  writeRestartRequest,
} from "./self-update.js";
import type { CostSummary } from "./types.js";
import type { TelegramClient, TelegramMessage, TelegramUpdate } from "./telegram.js";
import type { JobWorker } from "./worker.js";

const TELEGRAM_START_RETRY_MS = 3_000;

function startOfLocalDaySql(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (days - 1));
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function formatMoney(costUsd: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(costUsd);
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("en-US").format(tokens);
}

function formatCostLine(label: string, summary: CostSummary): string {
  if (summary.jobs === 0) return `${label}: no tracked runs`;
  const reported =
    summary.pricedJobs === 0
      ? "no provider-reported USD"
      : `${formatMoney(summary.costUsd)} reported`;
  const unpriced = summary.jobs - summary.pricedJobs;
  return `${label}: ${reported} across ${summary.jobs} run${summary.jobs === 1 ? "" : "s"}${
    unpriced ? `; ${unpriced} without a dollar figure` : ""
  }`;
}

function formatCostReport(periods: Array<{ label: string; summary: CostSummary }>): string {
  const selected = periods.at(-1)!;
  const codex = selected.summary.providers.codex.usage;
  return [
    "Spend (finished AIMessenger runs; provider-reported USD)",
    ...periods.map(({ label, summary }) => formatCostLine(label, summary)),
    `Codex and gateway tokens (${selected.label}; no dollar amount is available): ${formatTokens(codex.inputTokens)} input, ${formatTokens(codex.cachedInputTokens)} cached input, ${formatTokens(codex.outputTokens)} output`,
    "Use /cost <days> for a calendar window, or /cost all.",
  ].join("\n");
}

export class TelegramAgentService {
  private active = false;
  private pollAbort?: AbortController;
  private pollPromise?: Promise<void>;
  private pendingModelSelectionChatId?: number;
  private startRetryWake?: () => void;

  constructor(
    private readonly db: AppDatabase,
    private readonly telegram: TelegramClient,
    private readonly worker: JobWorker,
    private readonly config: Config,
    private readonly logger: AppLogger,
    private readonly modelCatalog: ModelCatalog,
    private readonly liveCodex?: LiveCodexConversations,
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    let me: { id: number; username?: string } | undefined;
    while (this.active && !me) {
      try {
        me = await this.telegram.initialize();
      } catch (error) {
        this.logger.error("telegram.initialize_failed", error);
        await this.waitForStartRetry();
      }
    }
    if (!this.active || !me) return;
    this.logger.info("telegram.ready", { bot: me.username ?? String(me.id) });
    await this.liveCodex?.start();
    this.worker.start();
    this.pollPromise = this.pollLoop();
  }

  async shutdown(): Promise<void> {
    this.active = false;
    this.startRetryWake?.();
    this.pollAbort?.abort();
    await this.pollPromise;
    await this.liveCodex?.shutdown();
    await this.worker.shutdown();
  }

  async prepareForSelfUpdate(timeoutMs: number): Promise<boolean> {
    this.active = false;
    this.pollAbort?.abort();
    await this.pollPromise;
    this.worker.pause();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.worker.getCurrentJobId() && !this.liveCodex?.isBusy?.()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async pollLoop(): Promise<void> {
    let offset = Number(this.db.getSetting("telegram_offset") ?? "0");
    while (this.active) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.telegram.getUpdates(offset, this.pollAbort.signal);
        for (const update of updates) {
          await this.handleUpdate(update);
          offset = Math.max(offset, update.update_id + 1);
          this.db.setSetting("telegram_offset", String(offset));
        }
      } catch (error) {
        if (!this.active || this.pollAbort.signal.aborted) break;
        this.logger.error("telegram.poll_failed", error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private async waitForStartRetry(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TELEGRAM_START_RETRY_MS);
      this.startRetryWake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.startRetryWake = undefined;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    if (
      message.chat.type !== "private" ||
      message.from.id !== this.config.TELEGRAM_ALLOWED_USER_ID
    ) {
      this.logger.warn("telegram.update_rejected", {
        update_id: update.update_id,
        reason: "unauthorized_or_non_private",
      });
      return;
    }
    const body = (message.text ?? message.caption ?? "").trim();
    const command = parseCommand(body);
    const hasPendingModelSelection = this.pendingModelSelectionChatId === message.chat.id;
    if (hasPendingModelSelection) this.pendingModelSelectionChatId = undefined;

    // A model picker accepts only the next plain-text, positive integer reply.
    if (hasPendingModelSelection && command.kind === "none" && message.text && /^[1-9]\d*$/.test(body)) {
      const fresh = this.db.recordUpdate(
        update.update_id,
        message.message_id,
        message.chat.id,
        message.from.id,
        body,
      );
      if (!fresh) return;
      this.logger.info("model.selection_received", { selection: Number(body) });
      await this.handleModel(message.chat.id, Number(body));
      return;
    }
    if (command.kind === "none") {
      await this.enqueueMessage(update, message, body);
      return;
    }
    if (command.kind === "switch") {
      const fresh = this.db.recordAndSetActiveProvider({
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        chatId: message.chat.id,
        userId: message.from.id,
        body,
        provider: command.provider,
      });
      if (!fresh) return;
      this.logger.info("provider.changed", { provider: command.provider });
      await this.telegram.sendText(
        message.chat.id,
        `New messages will use ${command.provider}. Context from the other provider will carry across.`,
      );
      return;
    }
    if (command.kind === "new") {
      const targets =
        command.target === "all" ? (["codex", "claude"] as const) : [command.target];
      const fresh = this.db.recordAndResetProvider({
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        chatId: message.chat.id,
        userId: message.from.id,
        body,
        targets: [...targets],
      });
      if (!fresh) return;
      this.logger.info("provider.sessions_reset", { target: command.target });
      if (targets.includes("codex")) await this.liveCodex?.reset(message.chat.id);
      await this.telegram.sendText(message.chat.id, `Reset ${targets.join(" and ")} session history.`);
      return;
    }
    if (command.kind === "retry") {
      const retried = this.db.recordAndRetryJob({
        requestedJobId: command.jobId,
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        chatId: message.chat.id,
        userId: message.from.id,
        body,
      });
      if (!retried.fresh) return;
      if (!retried.jobId) {
        this.logger.warn("job.retry_rejected", { requested_job_id: command.jobId });
        await this.telegram.sendText(
          message.chat.id,
          `Job #${command.jobId} is not failed, canceled, or interrupted.`,
        );
        return;
      }
      this.logger.info("job.retry_queued", {
        job_id: retried.jobId,
        requested_job_id: command.jobId,
      });
      this.worker.notify();
      await this.telegram.sendText(message.chat.id, "Retry queued.");
      return;
    }
    const fresh = this.db.recordUpdate(
      update.update_id,
      message.message_id,
      message.chat.id,
      message.from.id,
      body,
    );
    if (!fresh) return;
    this.logger.info("telegram.command_received", { command: command.kind });
    switch (command.kind) {
      case "start":
      case "help":
        await this.telegram.sendText(message.chat.id, HELP_TEXT);
        return;
      case "skills": {
        const catalog = loadSkills(this.config.skillsDir);
        this.logger.info("skills.listed", {
          count: catalog.skills.length,
          rejected: catalog.rejected,
        });
        const list = catalog.skills.length
          ? catalog.skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")
          : "No skills are installed.";
        await this.telegram.sendText(
          message.chat.id,
          `${list}\n\nAsk Iris to use a skill by name, or make a request matching its description.`,
        );
        return;
      }
      case "model": {
        const listed = await this.handleModel(message.chat.id, command.selection);
        if (listed) this.pendingModelSelectionChatId = message.chat.id;
        return;
      }
      case "status": {
        const activeProvider = this.db.getActiveProvider(this.config.DEFAULT_PROVIDER);
        const model = displayProviderModel(this.currentModel(activeProvider));
        const runtime = isGatewayModel(this.config, this.currentModel(activeProvider))
          ? "AI Security gateway"
          : activeProvider;
        const status = this.db.status();
        const live = this.liveCodex?.status(message.chat.id);
        const liveStatus = live?.active
          ? `Live Codex: ${live.state}${live.model ? ` (${displayProviderModel(live.model)})` : ""}`
          : "Live Codex: idle";
        const running = status.running
          ? `Running: job #${status.running.id} (${status.running.provider})`
          : "Running: nothing";
        const retryable = status.retryable
          ? `Latest retryable: job #${status.retryable.id} (${status.retryable.status})`
          : "Latest retryable: none";
        await this.telegram.sendText(
          message.chat.id,
          `Provider: ${activeProvider}\nRuntime: ${runtime}\nModel: ${model}\n${liveStatus}\n${running}\n${retryable}\nQueued: ${status.queued}\nPending delivery: ${this.db.pendingOutboxCount()}\nInterrupted: ${status.interrupted}\n${formatSelfUpdateStatus(readReleaseMetadata(this.config.appRoot), readSelfUpdateState(this.config.AIMESSENGER_DATA_DIR))}`,
        );
        return;
      }
      case "updates":
        await this.telegram.sendText(
          message.chat.id,
          formatSelfUpdateStatus(
            readReleaseMetadata(this.config.appRoot),
            readSelfUpdateState(this.config.AIMESSENGER_DATA_DIR),
          ),
        );
        return;
      case "rollback": {
        if (!this.config.SELF_UPDATE_ENABLED) {
          await this.telegram.sendText(message.chat.id, "Self-updates are disabled.");
          return;
        }
        try {
          const state = rollbackRelease(
            this.config.AIMESSENGER_WORKING_DIR,
            this.config.AIMESSENGER_DATA_DIR,
            { requestRestart: false },
          );
          startReleaseWatchdog({
            workspaceRoot: this.config.AIMESSENGER_WORKING_DIR,
            dataDir: this.config.AIMESSENGER_DATA_DIR,
            releaseId: state.currentReleaseId,
            port: this.config.AIMESSENGER_PORT,
            timeoutSeconds: this.config.SELF_UPDATE_WATCHDOG_SECONDS,
          });
          writeRestartRequest(this.config.AIMESSENGER_DATA_DIR, {
            releaseId: state.currentReleaseId,
            requestedAt: new Date().toISOString(),
          });
          this.logger.info("self_update.rollback_requested", {
            current_release_id: state.currentReleaseId,
            previous_release_id: state.previousReleaseId ?? null,
          });
          await this.telegram.sendText(
            message.chat.id,
            `Rolling back to ${state.currentReleaseId}. The service will restart after it drains active work.`,
          );
        } catch (error) {
          this.logger.error("self_update.rollback_rejected", error);
          await this.telegram.sendText(message.chat.id, "No previous healthy release is available.");
        }
        return;
      }
      case "cost": {
        const today = startOfLocalDaySql(1);
        if (command.window === "summary") {
          await this.telegram.sendText(
            message.chat.id,
            formatCostReport([
              { label: "Today", summary: this.db.costSummary(today) },
              { label: "Last 7 days", summary: this.db.costSummary(startOfLocalDaySql(7)) },
              { label: "All time", summary: this.db.costSummary() },
            ]),
          );
          return;
        }
        if (command.window === "all") {
          await this.telegram.sendText(
            message.chat.id,
            formatCostReport([{ label: "All time", summary: this.db.costSummary() }]),
          );
          return;
        }
        const days = command.days!;
        await this.telegram.sendText(
          message.chat.id,
          formatCostReport([
            {
              label: days === 1 ? "Today" : `Last ${days} days`,
              summary: this.db.costSummary(startOfLocalDaySql(days)),
            },
          ]),
        );
        return;
      }
      case "stop": {
        if (await this.liveCodex?.stop(message.chat.id)) {
          await this.telegram.sendText(message.chat.id, "Stopping the live Codex turn.");
          return;
        }
        const jobId = this.worker.stopCurrent();
        await this.telegram.sendText(
          message.chat.id,
          jobId ? `Stopping job #${jobId}. Its provider session will be reset.` : "No job is running.",
        );
        return;
      }
      case "unknown":
        await this.telegram.sendText(message.chat.id, `Unknown or incomplete command.\n\n${HELP_TEXT}`);
        return;
    }
  }

  private currentModel(provider: import("./types.js").ProviderName): string | undefined {
    return getProviderModel(this.config, provider, this.db.getSelectedModel(provider));
  }

  private async handleModel(chatId: number, selection: number | undefined): Promise<boolean> {
    const provider = this.db.getActiveProvider(this.config.DEFAULT_PROVIDER);
    let models: ModelOption[];
    try {
      models = await this.modelCatalog.list(provider);
    } catch (error) {
      this.logger.error("models.list_failed", error, { provider });
      await this.telegram.sendText(chatId, `Could not load ${provider} models right now.`);
      return false;
    }
    if (!models.length) {
      await this.telegram.sendText(chatId, `No selectable models are available for ${provider}.`);
      return false;
    }
    if (selection === undefined) {
      const list = models
        .map((model, index) =>
          `${index + 1}. **${model.name}** (\`${model.id}\`)${model.source ? ` - ${model.source}` : ""}`,
        )
        .join("\n");
      const runtime = isGatewayModel(this.config, this.currentModel(provider))
        ? "AI Security gateway"
        : provider;
      await this.telegram.sendText(
        chatId,
        `Current ${runtime} model: **${displayProviderModel(this.currentModel(provider))}**\n\n${list}\n\nReply with a number to switch.`,
      );
      return true;
    }
    const model = models[selection - 1];
    if (!model) {
      await this.telegram.sendText(chatId, `Choose a number from 1 to ${models.length}.`);
      return false;
    }
    this.db.setSelectedModel(provider, model.id);
    if (provider === "codex") await this.liveCodex?.reset(chatId);
    this.logger.info("model.selected", { provider, model: model.id });
    await this.telegram.sendText(
      chatId,
      `Using **${model.name}** (\`${model.id}\`). Started a fresh ${provider} session.`,
    );
    return false;
  }

  private async enqueueMessage(
    update: TelegramUpdate,
    message: TelegramMessage,
    body: string,
  ): Promise<void> {
    let attachments;
    try {
      attachments = extractRemoteAttachments(message);
    } catch (error) {
      this.logger.warn("telegram.message_rejected", {
        update_id: update.update_id,
        reason: "invalid_attachment",
      });
      await this.telegram.sendText(
        message.chat.id,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (!body && attachments.length === 0) {
      this.logger.info("telegram.message_rejected", {
        update_id: update.update_id,
        reason: "empty_message",
      });
      await this.telegram.sendText(
        message.chat.id,
        "Send text, a photo, or a file up to Telegram's 20 MB bot download limit.",
      );
      return;
    }
    const prompt = body || "Inspect the attached file and report the useful findings.";
    const provider = this.db.getActiveProvider(this.config.DEFAULT_PROVIDER);
    const model = this.currentModel(provider);
    if (
      provider === "codex" &&
      this.config.CODEX_LIVE_CONVERSATIONS &&
      attachments.length === 0 &&
      body &&
      !isGatewayModel(this.config, model) &&
      this.liveCodex
    ) {
      const handled = await this.liveCodex.accept({
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        chatId: message.chat.id,
        userId: message.from!.id,
        body,
        model,
      });
      if (handled) return;
    }
    const queued = this.db.enqueueInboundJob({
      updateId: update.update_id,
      telegramMessageId: message.message_id,
      chatId: message.chat.id,
      userId: message.from!.id,
      provider,
      prompt,
      body,
      attachments,
    });
    if (!queued.fresh || !queued.jobId) return;
    this.logger.info("job.queued", {
      job_id: queued.jobId,
      provider,
      update_id: update.update_id,
      text_length: body.length,
      attachment_count: attachments.length,
    });
    this.worker.notify();
  }
}
