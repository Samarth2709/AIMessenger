import type { Config } from "./config.js";
import { HELP_TEXT, parseCommand } from "./commands.js";
import type { AppDatabase } from "./db.js";
import { extractRemoteAttachments } from "./media.js";
import type { CostSummary } from "./types.js";
import type { TelegramClient, TelegramMessage, TelegramUpdate } from "./telegram.js";
import type { JobWorker } from "./worker.js";

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
    `Codex tokens (${selected.label}; Codex does not return a dollar amount): ${formatTokens(codex.inputTokens)} input, ${formatTokens(codex.cachedInputTokens)} cached input, ${formatTokens(codex.outputTokens)} output`,
    "Use /cost <days> for a calendar window, or /cost all.",
  ].join("\n");
}

export class TelegramAgentService {
  private active = false;
  private pollAbort?: AbortController;
  private pollPromise?: Promise<void>;

  constructor(
    private readonly db: AppDatabase,
    private readonly telegram: TelegramClient,
    private readonly worker: JobWorker,
    private readonly config: Config,
  ) {}

  async start(): Promise<void> {
    const me = await this.telegram.initialize();
    console.log(`Telegram bot @${me.username ?? me.id} is ready.`);
    this.worker.start();
    this.active = true;
    this.pollPromise = this.pollLoop();
  }

  async shutdown(): Promise<void> {
    this.active = false;
    this.pollAbort?.abort();
    await this.pollPromise;
    await this.worker.shutdown();
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
        console.error("Telegram polling failed", error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    if (
      message.chat.type !== "private" ||
      message.from.id !== this.config.TELEGRAM_ALLOWED_USER_ID
    ) {
      return;
    }
    const body = (message.text ?? message.caption ?? "").trim();
    const command = parseCommand(body);
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
        await this.telegram.sendText(
          message.chat.id,
          `Job #${command.jobId} is not failed, canceled, or interrupted.`,
        );
        return;
      }
      this.worker.notify();
      await this.telegram.sendText(message.chat.id, `Queued retry as job #${retried.jobId}.`);
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
    switch (command.kind) {
      case "start":
      case "help":
        await this.telegram.sendText(message.chat.id, HELP_TEXT);
        return;
      case "status": {
        const activeProvider = this.db.getActiveProvider(this.config.DEFAULT_PROVIDER);
        const status = this.db.status();
        const running = status.running
          ? `Running: job #${status.running.id} (${status.running.provider})`
          : "Running: nothing";
        await this.telegram.sendText(
          message.chat.id,
          `Provider: ${activeProvider}\n${running}\nQueued: ${status.queued}\nPending delivery: ${this.db.pendingOutboxCount()}\nInterrupted: ${status.interrupted}`,
        );
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

  private async enqueueMessage(
    update: TelegramUpdate,
    message: TelegramMessage,
    body: string,
  ): Promise<void> {
    let attachments;
    try {
      attachments = extractRemoteAttachments(message);
    } catch (error) {
      await this.telegram.sendText(
        message.chat.id,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (!body && attachments.length === 0) {
      await this.telegram.sendText(
        message.chat.id,
        "Send text, a supported image, or a document (PDF, Office, TXT, or CSV).",
      );
      return;
    }
    const prompt = body || "Inspect the attached file and report the useful findings.";
    const provider = this.db.getActiveProvider(this.config.DEFAULT_PROVIDER);
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
    const jobId = queued.jobId;
    this.worker.notify();
    await this.telegram.sendText(
      message.chat.id,
      `Queued job #${jobId} for ${provider}. Use /status or /stop.`,
    );
  }
}
