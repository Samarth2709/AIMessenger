import fs from "node:fs";
import path from "node:path";
import { CodexAppServer, type CodexAppServerEvent } from "./codex-app-server.js";
import type { Config } from "./config.js";
import type { AppDatabase } from "./db.js";
import type { AppLogger } from "./logger.js";
import { prepareResultOutbox } from "./outbound.js";
import { parseAgentResult, buildPrompt } from "./providers/structured.js";
import { codexCreditsForUsage } from "./pricing.js";
import { loadSkills } from "./skills.js";
import { MemoryService } from "./memory.js";
import { decideConversationContext } from "./conversation-context.js";
import type { TelegramClient } from "./telegram.js";
import type { TokenUsage } from "./types.js";

const TYPING_REFRESH_MS = 4_000;
// Keep normal follow-ups as one direct answer; progress is only useful for long work.
const INITIAL_PROGRESS_DELAY_MS = 20_000;

export interface LiveCodexMessage {
  updateId: number;
  telegramMessageId: number;
  chatId: number;
  userId: number;
  body: string;
  model?: string;
}

export interface LiveCodexStatus {
  active: boolean;
  state?: "starting" | "running";
  model?: string;
}

export interface LiveCodexConversations {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  accept(input: LiveCodexMessage): Promise<boolean>;
  status(chatId: number): LiveCodexStatus;
  isBusy?(): boolean;
  stop(chatId: number): Promise<boolean>;
  reset(chatId: number): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function agentMessageFromItems(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  let message: string | undefined;
  for (const item of value) {
    const record = asRecord(item);
    if (record?.type === "agentMessage" && typeof record.text === "string") message = record.text;
  }
  return message;
}

function tokenUsageFrom(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = numberAt(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens") ?? 0;
  const cachedInputTokens =
    numberAt(usage, "cached_input_tokens", "cachedInputTokens", "cached_tokens", "cachedTokens") ?? 0;
  const outputTokens =
    numberAt(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens") ?? 0;
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens };
}

function numberAt(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

export class LiveCodexConversationManager implements LiveCodexConversations {
  private active = false;
  private appServer?: CodexAppServer;
  private readonly typing = new Map<number, NodeJS.Timeout>();
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly steeringChats = new Set<number>();
  private readonly runningChats = new Set<number>();
  private readonly finalMessages = new Map<string, string>();
  private readonly turnStartedAt = new Map<string, number>();
  private readonly turnUsage = new Map<string, TokenUsage>();
  private readonly completingTurns = new Set<string>();
  private readonly firstMessageTimers = new Map<string, NodeJS.Timeout>();
  private readonly firstMessageDeliveries = new Map<string, Promise<void>>();
  private readonly memory: MemoryService;

  constructor(
    private readonly db: AppDatabase,
    private readonly telegram: TelegramClient,
    private readonly config: Config,
    private readonly logger: AppLogger,
    private readonly notifyDelivery: () => void,
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

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const recovered = this.db.recoverLiveConversations();
    if (recovered) this.logger.warn("live_codex.recovered_interrupted", { count: recovered });
  }

  async shutdown(): Promise<void> {
    this.active = false;
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.firstMessageTimers.values()) clearTimeout(timer);
    this.firstMessageTimers.clear();
    this.firstMessageDeliveries.clear();
    this.turnUsage.clear();
    this.turnStartedAt.clear();
    await this.appServer?.close();
  }

  async accept(input: LiveCodexMessage): Promise<boolean> {
    if (!this.active) return false;
    const queued = this.db.enqueueLiveCodexMessage({
      ...input,
      prompt: input.body,
    });
    if (!queued.fresh) return true;
    this.logger.info("live_codex.message_received", {
      chat_id: input.chatId,
      update_id: input.updateId,
      action: queued.action,
      model: input.model ?? "cli-default",
      text_length: input.body.length,
    });
    if (queued.action === "steer") {
      void this.flushSteering(input.chatId);
      return true;
    }

    this.db.recordJobDiagnostic(queued.jobId!, "ingress.accepted", {
      attachment_count: 0,
      attachment_mime_types: "",
      caption_present: true,
      request_is_attachment_fallback: false,
      request_length: input.body.length,
      mode: "live",
    });

    this.runningChats.add(input.chatId);
    this.armTimeout(input.chatId, queued.jobId!);
    await this.startTyping(input.chatId);
    void this.beginTurn(input.chatId, queued.jobId!);
    return true;
  }

  status(chatId: number): LiveCodexStatus {
    const conversation = this.db.getLiveConversation(chatId);
    if (!conversation || conversation.state === "idle") return { active: false };
    return {
      active: true,
      state: conversation.state,
      ...(conversation.model ? { model: conversation.model } : {}),
    };
  }

  isBusy(): boolean {
    return this.runningChats.size > 0;
  }

  async stop(chatId: number): Promise<boolean> {
    const interrupted = this.db.resetLiveConversation(chatId);
    if (!interrupted.jobId) return false;
    this.db.recordJobDiagnostic(interrupted.jobId, "job.canceled", {
      provider: "codex",
      cancellation_kind: "user_stop",
    });
    this.discardFirstMessage(interrupted.threadId, interrupted.turnId);
    this.clearChat(chatId);
    if (interrupted.threadId && interrupted.turnId) {
      try {
        await this.server().request("turn/interrupt", {
          threadId: interrupted.threadId,
          turnId: interrupted.turnId,
        });
      } catch (error) {
        this.logger.error("live_codex.interrupt_failed", error, { chat_id: chatId });
      }
    }
    this.logger.info("live_codex.stopped", { chat_id: chatId, job_id: interrupted.jobId });
    return true;
  }

  async reset(chatId: number): Promise<void> {
    const interrupted = this.db.resetLiveConversation(chatId, false);
    if (interrupted.jobId) {
      this.db.recordJobDiagnostic(interrupted.jobId, "job.canceled", {
        provider: "codex",
        cancellation_kind: "live_reset",
      });
    }
    this.discardFirstMessage(interrupted.threadId, interrupted.turnId);
    this.clearChat(chatId);
    if (interrupted.threadId && interrupted.turnId) {
      try {
        await this.server().request("turn/interrupt", {
          threadId: interrupted.threadId,
          turnId: interrupted.turnId,
        });
      } catch (error) {
        this.logger.error("live_codex.reset_interrupt_failed", error, { chat_id: chatId });
      }
    }
  }

  private async beginTurn(chatId: number, jobId: number): Promise<void> {
    try {
      const conversation = this.db.getLiveConversation(chatId);
      const job = this.db.getJob(jobId);
      if (!conversation || conversation.active_job_id !== jobId || conversation.state !== "starting" || !job) {
        return;
      }
      const server = this.server();
      await server.start();
      const threadId = conversation.thread_id
        ? await this.resumeThread(server, conversation.thread_id, conversation.model)
        : await this.startThread(server, conversation.model);
      const stillCurrent = this.db.getLiveConversation(chatId);
      if (!stillCurrent || stillCurrent.active_job_id !== jobId) return;

      const identity = fs.readFileSync(this.config.identityPath, "utf8").trim();
      if (!identity) throw new Error("The Iris identity file is empty.");
      const skills = loadSkills(this.config.skillsDir);
      if (skills.rejected) this.logger.warn("skills.rejected", { count: skills.rejected });
      const context = decideConversationContext(this.db, job);
      this.db.recordJobDiagnostic(jobId, "conversation_context.decided", {
        reason: context.reason,
        reference_count: context.referenceCount,
        media_reference_count: context.mediaReferenceCount,
        included: Boolean(context.context),
      });
      this.db.recordJobDiagnostic(jobId, "provider.invoked", {
        provider: "codex",
        model: conversation.model ?? "cli_default",
        mode: "live",
        attachment_count: 0,
        image_attachment_count: 0,
        attachment_input_mode: "live_text",
        direct_image_input: false,
        conversation_context_included: Boolean(context.context),
      });
      const prompt = buildPrompt(
        identity,
        skills.skills,
        { provider: "codex", model: conversation.model ?? undefined },
        job.prompt,
        this.memory.contextForJob(job.id),
        { attachmentPaths: [], conversationContext: context.context },
      );
      const outputSchema = JSON.parse(
        fs.readFileSync(path.join(this.config.appRoot, "schemas", "agent-result.schema.json"), "utf8"),
      ) as Record<string, unknown>;
      const response = await server.request("turn/start", {
        threadId,
        clientUserMessageId: String(job.telegram_message_id),
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.config.AIMESSENGER_WORKING_DIR,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        ...(conversation.model ? { model: conversation.model } : {}),
        outputSchema,
      });
      const turn = asRecord(response.turn);
      const turnId = stringAt(turn, "id");
      if (!turnId) throw new Error("Codex App Server did not return a turn ID.");
      if (!this.db.setLiveConversationTurn(chatId, jobId, threadId, turnId)) {
        await server.request("turn/interrupt", { threadId, turnId });
        return;
      }
      this.turnStartedAt.set(this.turnKey(threadId, turnId), Date.now());
      this.logger.info("live_codex.turn_started", { chat_id: chatId, job_id: jobId });
      void this.flushSteering(chatId);
    } catch (error) {
      await this.failTurn(chatId, jobId, error);
    }
  }

  private async startThread(server: CodexAppServer, model: string | null): Promise<string> {
    const response = await server.request("thread/start", {
      cwd: this.config.AIMESSENGER_WORKING_DIR,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ...(model ? { model } : {}),
    });
    const threadId = stringAt(asRecord(response.thread), "id");
    if (!threadId) throw new Error("Codex App Server did not return a thread ID.");
    return threadId;
  }

  private async resumeThread(
    server: CodexAppServer,
    threadId: string,
    model: string | null,
  ): Promise<string> {
    const response = await server.request("thread/resume", {
      threadId,
      cwd: this.config.AIMESSENGER_WORKING_DIR,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ...(model ? { model } : {}),
    });
    const resumedThreadId = stringAt(asRecord(response.thread), "id");
    if (!resumedThreadId) throw new Error("Codex App Server did not resume the thread.");
    return resumedThreadId;
  }

  private async flushSteering(chatId: number): Promise<void> {
    if (this.steeringChats.has(chatId)) return;
    this.steeringChats.add(chatId);
    try {
      while (this.active) {
        const conversation = this.db.getLiveConversation(chatId);
        if (!conversation || conversation.state !== "running" || !conversation.thread_id || !conversation.active_turn_id) {
          return;
        }
        const steer = this.db.nextLiveSteer(chatId);
        if (!steer) return;
        try {
          await this.server().request("turn/steer", {
            threadId: conversation.thread_id,
            expectedTurnId: conversation.active_turn_id,
            clientUserMessageId: String(steer.telegram_message_id),
            input: [{ type: "text", text: steer.prompt, text_elements: [] }],
          });
        } catch (error) {
          this.logger.error("live_codex.steer_failed", error, { chat_id: chatId });
          return;
        }
        this.db.markLiveSteerSent(steer.id);
        this.logger.info("live_codex.steered", { chat_id: chatId });
      }
    } finally {
      this.steeringChats.delete(chatId);
    }
  }

  private server(): CodexAppServer {
    if (!this.appServer) {
      this.appServer = new CodexAppServer(this.config.CODEX_COMMAND, this.config.AIMESSENGER_WORKING_DIR);
      this.appServer.onEvent((event) => this.onServerEvent(event));
      this.appServer.onClose(() => this.onServerClose());
    }
    return this.appServer;
  }

  private onServerEvent(event: CodexAppServerEvent): void {
    if (event.method === "thread/tokenUsage/updated") {
      const threadId = stringAt(event.params, "threadId");
      const turnId = stringAt(event.params, "turnId");
      const tokenUsage = asRecord(event.params.tokenUsage);
      const usage = tokenUsageFrom(tokenUsage?.last);
      if (threadId && turnId && usage) this.turnUsage.set(this.turnKey(threadId, turnId), usage);
      return;
    }
    if (event.method === "item/completed") {
      const item = asRecord(event.params.item);
      if (item?.type !== "agentMessage" || typeof item.text !== "string") return;
      const threadId = stringAt(event.params, "threadId");
      const turnId = stringAt(event.params, "turnId");
      if (threadId && turnId) {
        const key = this.turnKey(threadId, turnId);
        this.finalMessages.set(key, item.text);
        this.queueFirstMessage(threadId, turnId, item.text);
      }
      return;
    }
    if (event.method !== "turn/completed") return;
    const threadId = stringAt(event.params, "threadId");
    const turn = asRecord(event.params.turn);
    const turnId = stringAt(turn, "id");
    const status = stringAt(turn, "status");
    if (!threadId || !turnId || !status) return;
    const key = `${threadId}:${turnId}`;
    const finalMessage = agentMessageFromItems(turn?.items) ?? this.finalMessages.get(key);
    const usage = this.turnUsage.get(key) ?? tokenUsageFrom(turn?.usage) ?? tokenUsageFrom(event.params.usage);
    if (this.completingTurns.has(key)) return;
    this.completingTurns.add(key);
    void this.completeTurn(threadId, turnId, status, finalMessage, usage).finally(() => {
      this.completingTurns.delete(key);
      this.finalMessages.delete(key);
      this.turnUsage.delete(key);
      this.turnStartedAt.delete(key);
      this.discardFirstMessage(threadId, turnId);
    });
  }

  private async completeTurn(
    threadId: string,
    turnId: string,
    status: string,
    finalMessage: string | undefined,
    usage: TokenUsage | undefined,
  ): Promise<void> {
    for (const chatId of this.runningChats) {
      const conversation = this.db.getLiveConversation(chatId);
      if (
        !conversation ||
        conversation.thread_id !== threadId ||
        conversation.active_turn_id !== turnId ||
        !conversation.active_job_id
      ) {
        continue;
      }
      const jobId = conversation.active_job_id;
      if (status !== "completed") {
        this.discardFirstMessage(threadId, turnId);
        await this.failTurn(chatId, jobId, new Error("Codex ended the turn without completing it."));
        return;
      }
      await this.settleFirstMessage(threadId, turnId);
      const result = parseAgentResult(finalMessage ?? "");
      if (!result.message.trim() && result.attachments.length === 0) {
        await this.failTurn(chatId, jobId, new Error("Codex completed without a final response."));
        return;
      }
      const outbound = await prepareResultOutbox(result, chatId, jobId, this.config);
      const current = this.db.getLiveConversation(chatId);
      if (!current || current.active_job_id !== jobId) return;
      const codexCredits = codexCreditsForUsage(conversation.model ?? undefined, usage);
      const requestedHandoff = result.sessionDisposition === "handoff";
      const handoff =
        !result.attachments.length &&
        requestedHandoff &&
        this.memory.verifyHandoffReferences(jobId, result.memoryRefs);
      if (requestedHandoff && result.attachments.length) {
        this.logger.warn("media.handoff_retained", { chat_id: chatId, job_id: jobId, provider: "codex" });
      }
      if (requestedHandoff && !handoff && !result.attachments.length) {
        this.logger.warn("memory.handoff_rejected", { chat_id: chatId, job_id: jobId, provider: "codex" });
      }
      this.db.recordJobDiagnostic(jobId, "provider.completed", {
        result_length: result.message.length,
        output_attachment_count: result.attachments.length,
        outbox_count: outbound.length,
      });
      this.db.completeJob(
        jobId,
        result.message,
        "codex",
        handoff ? null : threadId,
        outbound,
        {
          model: conversation.model ?? undefined,
          ...(usage ? { usage } : {}),
          ...(codexCredits !== undefined ? { codexCredits } : {}),
        },
      );
      if (!this.db.finishLiveConversation(chatId, jobId, handoff)) return;
      this.clearChat(chatId);
      this.logger.info("live_codex.turn_completed", {
        chat_id: chatId,
        job_id: jobId,
        outbound_count: outbound.length,
        result_length: result.message.length,
      });
      this.notifyDelivery();
      const followup = this.db.startPendingLiveFollowup(chatId);
      if (followup.jobId) {
        this.runningChats.add(chatId);
        this.armTimeout(chatId, followup.jobId);
        await this.startTyping(chatId);
        void this.beginTurn(chatId, followup.jobId);
      }
      return;
    }
  }

  private async failTurn(chatId: number, jobId: number, error: unknown): Promise<void> {
    const conversation = this.db.getLiveConversation(chatId);
    this.discardFirstMessage(conversation?.thread_id ?? undefined, conversation?.active_turn_id ?? undefined);
    const changed = this.db.failLiveConversation(
      chatId,
      jobId,
      "failed",
      "The live Codex conversation ended before it produced a final response.",
      true,
    );
    if (!changed) return;
    this.db.recordJobDiagnostic(jobId, "job.failed", {
      provider: "codex",
      failure_kind: "live_codex",
    });
    this.clearChat(chatId);
    if (conversation?.thread_id && conversation.active_turn_id) {
      void this.server()
        .request("turn/interrupt", {
          threadId: conversation.thread_id,
          turnId: conversation.active_turn_id,
        })
        .catch((interruptError) => {
          this.logger.error("live_codex.failure_interrupt_failed", interruptError, { chat_id: chatId });
        });
    }
    this.logger.error("live_codex.turn_failed", error, { chat_id: chatId, job_id: jobId });
    await this.sendFailure(chatId, jobId, "I ran into a Codex session error. Send your request again, or use /status.");
  }

  private onServerClose(): void {
    if (!this.active) return;
    for (const chatId of [...this.runningChats]) {
      const conversation = this.db.getLiveConversation(chatId);
      if (conversation?.active_job_id) {
        void this.failTurn(chatId, conversation.active_job_id, new Error("Codex App Server stopped."));
      }
    }
  }

  private armTimeout(chatId: number, jobId: number): void {
    this.clearTimeout(chatId);
    const timer = setTimeout(() => {
      const conversation = this.db.getLiveConversation(chatId);
      if (!conversation || conversation.active_job_id !== jobId) return;
      void this.failTurn(chatId, jobId, new Error("Codex live turn timed out."));
    }, this.config.JOB_TIMEOUT_MINUTES * 60_000);
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private async startTyping(chatId: number): Promise<void> {
    if (this.typing.has(chatId)) return;
    await this.sendTyping(chatId, "initial");
    const timer = setInterval(() => void this.sendTyping(chatId, "refresh"), TYPING_REFRESH_MS);
    timer.unref();
    this.typing.set(chatId, timer);
  }

  private async sendTyping(chatId: number, phase: "initial" | "refresh"): Promise<void> {
    try {
      await this.telegram.sendTyping(chatId);
      this.logger.info("telegram.typing_sent", { phase, source: "live_codex" });
    } catch (error) {
      this.logger.error("telegram.typing_failed", error, { phase, source: "live_codex" });
    }
  }

  private queueFirstMessage(threadId: string, turnId: string, text: string): void {
    const key = this.turnKey(threadId, turnId);
    if (!text.trim() || this.firstMessageTimers.has(key) || this.firstMessageDeliveries.has(key)) return;
    const startedAt = this.turnStartedAt.get(key) ?? Date.now();
    const delay = Math.max(0, INITIAL_PROGRESS_DELAY_MS - (Date.now() - startedAt));
    const timer = setTimeout(() => {
      this.firstMessageTimers.delete(key);
      this.firstMessageDeliveries.set(key, this.sendFirstAgentMessage(threadId, turnId, text));
    }, delay);
    timer.unref();
    this.firstMessageTimers.set(key, timer);
  }

  private async settleFirstMessage(threadId: string, turnId: string): Promise<void> {
    const key = this.turnKey(threadId, turnId);
    const timer = this.firstMessageTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.firstMessageTimers.delete(key);
      return;
    }
    const delivery = this.firstMessageDeliveries.get(key);
    if (!delivery) return;
    await delivery;
    this.firstMessageDeliveries.delete(key);
  }

  private discardFirstMessage(threadId: string | undefined, turnId: string | undefined): void {
    if (!threadId || !turnId) return;
    const key = this.turnKey(threadId, turnId);
    const timer = this.firstMessageTimers.get(key);
    if (timer) clearTimeout(timer);
    this.firstMessageTimers.delete(key);
    this.firstMessageDeliveries.delete(key);
    this.turnStartedAt.delete(key);
  }

  private async sendFirstAgentMessage(threadId: string, turnId: string, text: string): Promise<void> {
    const active = this.activeLiveTurn(threadId, turnId);
    if (!active) return;
    const message = parseAgentResult(text).message.trim();
    if (!message) return;
    try {
      const messageIds = await this.telegram.sendText(active.chatId, message, active.jobId);
      for (const messageId of messageIds) this.db.recordOutbound(messageId, active.jobId, "live_initial");
      this.logger.info("live_codex.first_message_sent", { chat_id: active.chatId, job_id: active.jobId });
    } catch (error) {
      this.logger.error("live_codex.first_message_failed", error, { chat_id: active.chatId, job_id: active.jobId });
    }
  }

  private activeLiveTurn(threadId: string, turnId: string): { chatId: number; jobId: number } | undefined {
    for (const chatId of this.runningChats) {
      const conversation = this.db.getLiveConversation(chatId);
      if (
        conversation?.thread_id === threadId &&
        conversation.active_turn_id === turnId &&
        conversation.active_job_id
      ) {
        return { chatId, jobId: conversation.active_job_id };
      }
    }
    return undefined;
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private async sendFailure(chatId: number, jobId: number, text: string): Promise<void> {
    try {
      const messageIds = await this.telegram.sendText(chatId, text);
      for (const messageId of messageIds) this.db.recordOutbound(messageId, jobId, "failure");
    } catch (error) {
      this.logger.error("live_codex.failure_notice_failed", error, { chat_id: chatId, job_id: jobId });
    }
  }

  private clearChat(chatId: number): void {
    this.runningChats.delete(chatId);
    const typing = this.typing.get(chatId);
    if (typing) clearInterval(typing);
    this.typing.delete(chatId);
    this.clearTimeout(chatId);
  }

  private clearTimeout(chatId: number): void {
    const timer = this.timers.get(chatId);
    if (timer) clearTimeout(timer);
    this.timers.delete(chatId);
  }
}
