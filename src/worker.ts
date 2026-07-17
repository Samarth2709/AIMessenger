import fsSync from "node:fs";
import path from "node:path";
import { getProviderModel, isGatewayModel, type Config } from "./config.js";
import type { AppDatabase } from "./db.js";
import type { AppLogger } from "./logger.js";
import { downloadAttachments } from "./media.js";
import { prepareResultOutbox } from "./outbound.js";
import { codexCreditsForUsage } from "./pricing.js";
import { ProviderRunError, type AgentProvider } from "./providers/types.js";
import { loadSkills } from "./skills.js";
import { MemoryService } from "./memory.js";
import type { ProviderName, RemoteAttachment } from "./types.js";
import type { TelegramClient } from "./telegram.js";

const TYPING_REFRESH_MS = 4_000;

export class JobWorker {
  private active = false;
  private loopPromise?: Promise<void>;
  private currentAbort?: AbortController;
  private currentJobId?: number;
  private wake?: () => void;
  private acceptingJobs = true;
  private readonly memory: MemoryService;

  constructor(
    private readonly db: AppDatabase,
    private readonly telegram: TelegramClient,
    private readonly providers: Record<ProviderName, AgentProvider>,
    private readonly config: Config,
    private readonly logger: AppLogger,
    memory?: MemoryService,
  ) {
    const dataDir = config.AIMESSENGER_DATA_DIR ?? path.dirname(config.jobsDir);
    this.memory =
      memory ??
      new MemoryService({
        memoryDir: config.memoryDir ?? path.join(dataDir, "memory"),
        databasePath: config.databasePath ?? path.join(dataDir, "aimessenger.sqlite"),
        cliPath: config.memoryCliPath ?? path.join(config.appRoot, "dist", "src", "memory-cli.js"),
        db,
      });
  }

  start(): void {
    if (this.active) return;
    for (const pid of this.db.runningProcessPids()) {
      try {
        process.kill(-pid, "SIGKILL");
        this.logger.warn("worker.orphan_process_killed", { process_pid: pid });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const recovered = this.db.recoverInterruptedJobs();
    if (recovered) this.logger.warn("job.recovered_interrupted", { count: recovered });
    const recoveredOutbox = this.db.recoverOutbox();
    if (recoveredOutbox) this.logger.warn("outbox.recovered", { count: recoveredOutbox });
    this.active = true;
    this.acceptingJobs = true;
    this.logger.info("worker.started");
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

  pause(): void {
    this.acceptingJobs = false;
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
      if (!this.acceptingJobs) {
        await this.waitForWork();
        continue;
      }
      const job = this.db.claimNextJob();
      if (!job) {
        await this.waitForWork();
        continue;
      }
      this.currentJobId = job.id;
      this.currentAbort = new AbortController();
      const startedAt = Date.now();
      this.logger.info("job.started", { job_id: job.id, provider: job.provider });
      const timeout = setTimeout(
        () => this.currentAbort?.abort(),
        this.config.JOB_TIMEOUT_MINUTES * 60_000,
      );
      timeout.unref();

      try {
        const result = await this.processJob(job.id, this.currentAbort.signal);
        this.logger.info("job.completed", {
          job_id: job.id,
          provider: job.provider,
          duration_ms: Date.now() - startedAt,
          ...result,
        });
      } catch (error) {
        const canceled = this.currentAbort.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        this.db.failJob(
          job.id,
          canceled ? "canceled" : "failed",
          message,
          error instanceof ProviderRunError ? error.metrics : undefined,
        );
        this.db.taintProvider(job.provider);
        const context = {
          job_id: job.id,
          provider: job.provider,
          duration_ms: Date.now() - startedAt,
        };
        if (canceled) {
          this.logger.warn("job.canceled", context);
        } else {
          this.logger.error("job.failed", error, context);
        }
        if (!canceled) {
          await this.safeSend(
            job.chat_id,
            `Your request failed: ${message}\nUse /status to view recovery options.`,
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

  private async processJob(
    jobId: number,
    signal: AbortSignal,
  ): Promise<{
    attachment_count: number;
    outbound_count: number;
    result_length: number;
    skill_count: number;
  }> {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} disappeared.`);
    const typing = await this.startTyping(job.chat_id);
    try {
      const identity = fsSync.readFileSync(this.config.identityPath, "utf8").trim();
      if (!identity) throw new Error(`Identity file is empty: ${this.config.identityPath}`);
      const skills = loadSkills(this.config.skillsDir);
      if (skills.rejected) this.logger.warn("skills.rejected", { count: skills.rejected });
      const remoteAttachments = JSON.parse(job.attachments_json) as RemoteAttachment[];
      const jobDir = path.join(this.config.jobsDir, String(job.id));
      const attachmentPaths = await downloadAttachments(
        this.telegram,
        remoteAttachments,
        jobDir,
      );
      const session = this.db.getProviderSession(job.provider);
      const model = getProviderModel(
        this.config,
        job.provider,
        this.db.getSelectedModel(job.provider),
      );
      const output = await this.providers[job.provider].run({
        identity,
        skills: skills.skills,
        provider: job.provider,
        model,
        prompt: job.prompt,
        memory: this.memory.contextForJob(job.id),
        attachmentPaths,
        sessionId: session.tainted ? null : session.session_id,
        workingDirectory: this.config.AIMESSENGER_WORKING_DIR,
        schemaPath: path.join(this.config.appRoot, "schemas", "agent-result.schema.json"),
        signal,
        onProcessStart: (pid) => this.db.setJobProcessPid(job.id, pid),
      });
      if (signal.aborted) throw new DOMException("Job canceled.", "AbortError");
      if (!output.result.message.trim() && output.result.attachments.length === 0) {
        throw new Error("Agent completed without a message or attachment.");
      }

      const outbound = await prepareResultOutbox(output.result, job.chat_id, job.id, this.config);
      const requestedHandoff = output.result.sessionDisposition === "handoff";
      const handoff =
        requestedHandoff && this.memory.verifyHandoffReferences(job.id, output.result.memoryRefs);
      if (requestedHandoff && !handoff) {
        this.logger.warn("memory.handoff_rejected", { job_id: job.id, provider: job.provider });
      }
      const codexCredits =
        job.provider === "codex" && !isGatewayModel(this.config, model)
          ? codexCreditsForUsage(model, output.metrics?.usage)
          : undefined;
      this.db.completeJob(
        job.id,
        output.result.message,
        job.provider,
        handoff ? null : output.sessionId,
        outbound,
        {
          ...output.metrics,
          model,
          ...(codexCredits !== undefined ? { codexCredits } : {}),
        },
      );
      this.notify();
      return {
        attachment_count: remoteAttachments.length,
        outbound_count: outbound.length,
        result_length: output.result.message.length,
        skill_count: skills.skills.length,
      };
    } finally {
      clearInterval(typing);
    }
  }

  private async startTyping(chatId: number): Promise<NodeJS.Timeout> {
    await this.sendTyping(chatId, "initial");
    const interval = setInterval(() => {
      void this.sendTyping(chatId, "refresh");
    }, TYPING_REFRESH_MS);
    interval.unref();
    return interval;
  }

  private async sendTyping(chatId: number, phase: "initial" | "refresh"): Promise<void> {
    try {
      await this.telegram.sendTyping(chatId);
      this.logger.info("telegram.typing_sent", { phase });
    } catch (error) {
      this.logger.error("telegram.typing_failed", error, { phase });
    }
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
      this.logger.info("telegram.delivery_sent", {
        outbox_id: outbox.id,
        job_id: outbox.job_id,
        kind: outbox.kind,
        attempt: outbox.attempts + 1,
      });
    } catch (error) {
      this.db.retryOutbox(outbox.id, error instanceof Error ? error.message : String(error));
      this.logger.error("telegram.delivery_failed", error, {
        outbox_id: outbox.id,
        job_id: outbox.job_id,
        kind: outbox.kind,
        next_attempt: outbox.attempts + 1,
      });
    }
  }

  private async safeSend(chatId: number, text: string, jobId: number): Promise<void> {
    try {
      const ids = await this.telegram.sendText(chatId, text, jobId);
      for (const id of ids) this.db.recordOutbound(id, jobId, "text");
    } catch (error) {
      this.logger.error("telegram.failure_notice_failed", error, { job_id: jobId });
    }
  }
}
