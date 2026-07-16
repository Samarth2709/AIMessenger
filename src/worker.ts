import fs from "node:fs/promises";
import path from "node:path";
import { chunkText } from "./chunk.js";
import type { Config } from "./config.js";
import type { AppDatabase } from "./db.js";
import { downloadAttachments, validateOutboundAttachment } from "./media.js";
import type { AgentProvider } from "./providers/types.js";
import type { OutboxInput, ProviderName, RemoteAttachment } from "./types.js";
import type { TelegramClient } from "./telegram.js";

export class JobWorker {
  private active = false;
  private loopPromise?: Promise<void>;
  private currentAbort?: AbortController;
  private currentJobId?: number;
  private wake?: () => void;

  constructor(
    private readonly db: AppDatabase,
    private readonly telegram: TelegramClient,
    private readonly providers: Record<ProviderName, AgentProvider>,
    private readonly config: Config,
  ) {}

  start(): void {
    if (this.active) return;
    for (const pid of this.db.runningProcessPids()) {
      try {
        process.kill(-pid, "SIGKILL");
        console.warn(`Killed orphaned agent process group ${pid}.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const recovered = this.db.recoverInterruptedJobs();
    if (recovered) console.warn(`Marked ${recovered} previously running job(s) interrupted.`);
    this.db.recoverOutbox();
    this.active = true;
    this.loopPromise = this.runLoop();
  }

  async shutdown(): Promise<void> {
    this.active = false;
    this.currentAbort?.abort();
    this.wake?.();
    await this.loopPromise;
  }

  notify(): void {
    this.wake?.();
  }

  stopCurrent(): number | undefined {
    const jobId = this.currentJobId;
    this.currentAbort?.abort();
    return jobId;
  }

  getCurrentJobId(): number | undefined {
    return this.currentJobId;
  }

  private async waitForWork(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }

  private async runLoop(): Promise<void> {
    while (this.active) {
      const outbound = this.db.claimNextOutbox();
      if (outbound) {
        await this.deliverOutbox(outbound);
        continue;
      }
      const job = this.db.claimNextJob();
      if (!job) {
        await this.waitForWork();
        continue;
      }
      this.currentJobId = job.id;
      this.currentAbort = new AbortController();
      const timeout = setTimeout(
        () => this.currentAbort?.abort(),
        this.config.JOB_TIMEOUT_MINUTES * 60_000,
      );
      timeout.unref();

      try {
        await this.processJob(job.id, this.currentAbort.signal);
      } catch (error) {
        const canceled = this.currentAbort.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        this.db.failJob(job.id, canceled ? "canceled" : "failed", message);
        this.db.taintProvider(job.provider);
        if (!canceled) {
          await this.safeSend(
            job.chat_id,
            `Job #${job.id} failed: ${message}\nUse /retry ${job.id} to try it again.`,
            job.id,
          );
        }
      } finally {
        clearTimeout(timeout);
        this.currentAbort = undefined;
        this.currentJobId = undefined;
      }
    }
  }

  private async processJob(jobId: number, signal: AbortSignal): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} disappeared.`);
    await this.telegram.sendTyping(job.chat_id).catch(() => undefined);

    const remoteAttachments = JSON.parse(job.attachments_json) as RemoteAttachment[];
    const jobDir = path.join(this.config.jobsDir, String(job.id));
    const attachmentPaths = await downloadAttachments(
      this.telegram,
      remoteAttachments,
      jobDir,
    );
    const session = this.db.getProviderSession(job.provider);
    const output = await this.providers[job.provider].run({
      prompt: job.prompt,
      context: this.db.getContext(job.provider, job.user_message_id),
      attachmentPaths,
      sessionId: session.tainted ? null : session.session_id,
      workingDirectory: this.config.AIMESSENGER_WORKING_DIR,
      schemaPath: path.join(this.config.appRoot, "schemas", "agent-result.schema.json"),
      signal,
      onProcessStart: (pid) => this.db.setJobProcessPid(job.id, pid),
    });
    if (signal.aborted) throw new DOMException("Job canceled.", "AbortError");

    const outbound: OutboxInput[] = chunkText(output.result.message).map((text) => ({
      chatId: job.chat_id,
      kind: "text",
      payload: { text },
    }));
    for (const attachment of output.result.attachments) {
      try {
        const validated = await validateOutboundAttachment(
          attachment.path,
          this.config.AIMESSENGER_WORKING_DIR,
        );
        const outputDir = path.join(jobDir, "output");
        await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
        const durablePath = path.join(
          outputDir,
          `${outbound.length + 1}-${path.basename(validated)}`,
        );
        await fs.copyFile(validated, durablePath);
        await fs.chmod(durablePath, 0o600);
        outbound.push({
          chatId: job.chat_id,
          kind: "document",
          payload: { path: durablePath, ...(attachment.caption ? { caption: attachment.caption } : {}) },
        });
      } catch (error) {
        outbound.push({
          chatId: job.chat_id,
          kind: "text",
          payload: {
            text: `Could not prepare attachment ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      }
    }
    this.db.completeJob(job.id, output.result.message, job.provider, output.sessionId, outbound);
    this.notify();
  }

  private async deliverOutbox(outbox: import("./types.js").OutboxRow): Promise<void> {
    try {
      const payload = JSON.parse(outbox.payload_json) as Record<string, unknown>;
      let telegramMessageId: number;
      if (outbox.kind === "text") {
        const ids = await this.telegram.sendText(outbox.chat_id, String(payload.text ?? ""));
        if (ids.length !== 1) throw new Error("Durable text outbox item produced multiple messages.");
        telegramMessageId = ids[0]!;
      } else {
        telegramMessageId = await this.telegram.sendFile(
          outbox.chat_id,
          String(payload.path),
          typeof payload.caption === "string" ? payload.caption : undefined,
        );
      }
      this.db.completeOutbox(outbox.id, telegramMessageId);
      this.db.recordOutbound(telegramMessageId, outbox.job_id, outbox.kind);
    } catch (error) {
      this.db.retryOutbox(outbox.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async safeSend(chatId: number, text: string, jobId: number): Promise<void> {
    try {
      const ids = await this.telegram.sendText(chatId, text, jobId);
      for (const id of ids) this.db.recordOutbound(id, jobId, "text");
    } catch (error) {
      console.error("Telegram send failed", error);
    }
  }
}
