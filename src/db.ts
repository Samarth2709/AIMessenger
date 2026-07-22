import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  type CostProviderSummary,
  type CostSummary,
  type JobMetrics,
  type JobRow,
  type LiveConversationRow,
  type LiveSteerRow,
  type OutboxInput,
  type OutboxRow,
  type ProviderName,
  type ProviderSessionRow,
  type RemoteAttachment,
} from "./types.js";

const DIAGNOSTIC_EVENTS = [
  "ingress.accepted",
  "attachments.downloaded",
  "conversation_context.decided",
  "provider.invoked",
  "provider.completed",
  "job.failed",
  "job.canceled",
  "delivery.sent",
  "delivery.retry",
] as const;

type JobDiagnosticEvent = typeof DIAGNOSTIC_EVENTS[number];
type JobDiagnosticDetails = Record<string, boolean | number | string | null>;

export class AppDatabase {
  readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(databasePath), 0o700);
    this.db = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    for (const suffix of ["-wal", "-shm"]) {
      const sqliteFile = `${databasePath}${suffix}`;
      if (fs.existsSync(sqliteFile)) fs.chmodSync(sqliteFile, 0o600);
    }
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_updates (
        update_id INTEGER PRIMARY KEY,
        telegram_message_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transcript (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        provider TEXT,
        chat_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        user_message_id INTEGER NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        prompt TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal', 'deep_research')),
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'canceled', 'interrupted')),
        retry_of INTEGER,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        result_text TEXT,
        process_pid INTEGER,
        model TEXT,
        requested_model TEXT,
        fallback_reason TEXT,
        cost_usd REAL,
        cost_credits REAL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        usage_recorded_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(update_id) REFERENCES inbound_updates(update_id),
        FOREIGN KEY(user_message_id) REFERENCES transcript(id),
        FOREIGN KEY(retry_of) REFERENCES jobs(id)
      );

      CREATE INDEX IF NOT EXISTS jobs_status_id ON jobs(status, id);

      CREATE TABLE IF NOT EXISTS job_diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );

      CREATE INDEX IF NOT EXISTS job_diagnostics_job_id_id ON job_diagnostics(job_id, id);

      CREATE TABLE IF NOT EXISTS job_processes (
        job_id INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY(job_id, pid),
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS live_conversations (
        chat_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('idle', 'starting', 'running')),
        thread_id TEXT,
        active_turn_id TEXT,
        active_job_id INTEGER,
        model TEXT,
        steering_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(active_job_id) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS live_steer_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        update_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        transcript_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sent')) DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(update_id) REFERENCES inbound_updates(update_id),
        FOREIGN KEY(transcript_id) REFERENCES transcript(id)
      );

      CREATE INDEX IF NOT EXISTS live_steer_messages_chat_status_id
        ON live_steer_messages(chat_id, status, id);

      CREATE TABLE IF NOT EXISTS provider_sessions (
        provider TEXT PRIMARY KEY CHECK(provider IN ('codex', 'claude')),
        session_id TEXT,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        tainted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        telegram_message_id INTEGER PRIMARY KEY,
        job_id INTEGER,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text', 'document')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_error TEXT,
        telegram_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );

      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, available_at, id);

      CREATE TABLE IF NOT EXISTS transcript_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcript_id INTEGER NOT NULL,
        outbox_id INTEGER NOT NULL UNIQUE,
        ordinal INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        caption TEXT,
        sha256 TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK(provenance IN ('web', 'generated', 'local', 'unknown')),
        source_url TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(transcript_id) REFERENCES transcript(id),
        FOREIGN KEY(outbox_id) REFERENCES outbox(id)
      );

      CREATE INDEX IF NOT EXISTS transcript_attachments_transcript_ordinal
        ON transcript_attachments(transcript_id, ordinal);

      INSERT OR IGNORE INTO provider_sessions(provider) VALUES ('codex'), ('claude');
    `);
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const additions = [
      ["process_pid", "INTEGER"],
      ["model", "TEXT"],
      ["cost_usd", "REAL"],
      ["cost_credits", "REAL"],
      ["input_tokens", "INTEGER"],
      ["cached_input_tokens", "INTEGER"],
      ["output_tokens", "INTEGER"],
      ["usage_recorded_at", "TEXT"],
      ["mode", "TEXT NOT NULL DEFAULT 'normal'"],
      ["requested_model", "TEXT"],
      ["fallback_reason", "TEXT"],
    ] as const;
    for (const [name, type] of additions) {
      if (!jobColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
    }
    const transcriptColumns = this.db.prepare("PRAGMA table_info(transcript)").all() as Array<{ name: string }>;
    if (!transcriptColumns.some((column) => column.name === "chat_id")) {
      this.db.exec("ALTER TABLE transcript ADD COLUMN chat_id INTEGER");
      this.db.exec(`
        UPDATE transcript
        SET chat_id = (
          SELECT jobs.chat_id FROM jobs WHERE jobs.user_message_id = transcript.id
        )
        WHERE role = 'user' AND chat_id IS NULL
      `);
      const chatIds = this.db
        .prepare("SELECT DISTINCT chat_id FROM jobs ORDER BY chat_id")
        .all() as Array<{ chat_id: number }>;
      if (chatIds.length === 1) {
        this.db.prepare("UPDATE transcript SET chat_id = ? WHERE chat_id IS NULL").run(chatIds[0]!.chat_id);
      }
    }
    const hasTranscriptFts = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_fts'")
        .get(),
    );
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts
      USING fts5(content, content = 'transcript', content_rowid = 'id');

      CREATE TRIGGER IF NOT EXISTS transcript_fts_insert
      AFTER INSERT ON transcript BEGIN
        INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    if (!hasTranscriptFts) {
      this.db.exec("INSERT INTO transcript_fts(transcript_fts) VALUES ('rebuild')");
    }
    this.backfillTranscriptAttachments();
  }

  private backfillTranscriptAttachments(): void {
    const legacy = this.db
      .prepare(
        `SELECT outbox.id AS outbox_id, outbox.job_id, outbox.payload_json,
                jobs.chat_id, jobs.user_message_id, jobs.result_text
         FROM outbox
         JOIN jobs ON jobs.id = outbox.job_id
         LEFT JOIN transcript_attachments ON transcript_attachments.outbox_id = outbox.id
         WHERE outbox.kind = 'document'
           AND transcript_attachments.id IS NULL
           AND jobs.status = 'completed'
           AND jobs.result_text IS NOT NULL
         ORDER BY outbox.id`,
      )
      .all() as Array<{
      outbox_id: number;
      job_id: number;
      payload_json: string;
      chat_id: number;
      user_message_id: number;
      result_text: string;
    }>;
    if (!legacy.length) return;
    const assistantCandidates = this.db.prepare(
      `SELECT id FROM transcript
       WHERE chat_id = ? AND role = 'assistant' AND id > ? AND content = ?
       ORDER BY id LIMIT 2`,
    );
    const nextOrdinal = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM transcript_attachments WHERE transcript_id = ?",
    );
    const insert = this.db.prepare(
      `INSERT INTO transcript_attachments
        (transcript_id, outbox_id, ordinal, file_name, media_type, caption, sha256, provenance, source_url)
       VALUES (?, ?, ?, ?, ?, ?, 'legacy-unknown', 'unknown', NULL)`,
    );
    this.db.transaction(() => {
      for (const item of legacy) {
        let payload: Record<string, unknown>;
        try {
          const value = JSON.parse(item.payload_json);
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          payload = value as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof payload.path !== "string") continue;
        const assistants = assistantCandidates.all(
          item.chat_id,
          item.user_message_id,
          item.result_text,
        ) as Array<{ id: number }>;
        if (assistants.length !== 1) continue;
        const assistant = assistants[0]!;
        const ordinal = nextOrdinal.get(assistant.id) as { ordinal: number };
        const fileName = path.basename(payload.path) || "attachment";
        insert.run(
          assistant.id,
          item.outbox_id,
          ordinal.ordinal,
          fileName,
          mediaTypeForFileName(fileName),
          typeof payload.caption === "string" ? payload.caption : null,
        );
      }
    })();
  }

  close(): void {
    this.db.close();
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getActiveProvider(defaultProvider: ProviderName): ProviderName {
    const stored = this.getSetting("active_provider");
    return stored === "claude" || stored === "codex" ? stored : defaultProvider;
  }

  setActiveProvider(provider: ProviderName): void {
    this.setSetting("active_provider", provider);
  }

  getSelectedModel(provider: ProviderName): string | undefined {
    return this.getSetting(`selected_model_${provider}`);
  }

  setSelectedModel(provider: ProviderName, model: string): void {
    this.db.transaction(() => {
      this.setSetting(`selected_model_${provider}`, model);
      this.resetProvider(provider);
    })();
  }

  clearSelectedModel(provider: ProviderName): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(`selected_model_${provider}`);
      this.resetProvider(provider);
    })();
  }

  recordAndSetActiveProvider(input: {
    updateId: number;
    telegramMessageId: number;
    chatId: number;
    userId: number;
    body: string;
    provider: ProviderName;
  }): boolean {
    return this.db.transaction(() => {
      const fresh = this.recordUpdate(
        input.updateId,
        input.telegramMessageId,
        input.chatId,
        input.userId,
        input.body,
      );
      if (fresh) this.setActiveProvider(input.provider);
      return fresh;
    })();
  }

  recordAndResetProvider(input: {
    updateId: number;
    telegramMessageId: number;
    chatId: number;
    userId: number;
    body: string;
    targets: ProviderName[];
  }): boolean {
    return this.db.transaction(() => {
      const fresh = this.recordUpdate(
        input.updateId,
        input.telegramMessageId,
        input.chatId,
        input.userId,
        input.body,
      );
      if (fresh) for (const provider of input.targets) this.resetProvider(provider);
      return fresh;
    })();
  }

  recordUpdate(
    updateId: number,
    telegramMessageId: number,
    chatId: number,
    userId: number,
    body: string,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_updates
          (update_id, telegram_message_id, chat_id, user_id, body)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(updateId, telegramMessageId, chatId, userId, body);
    return result.changes === 1;
  }

  enqueueJob(input: {
    updateId: number;
    telegramMessageId: number;
    chatId: number;
    provider: ProviderName;
    prompt: string;
    attachments: RemoteAttachment[];
    mode?: import("./types.js").JobMode;
    retryOf?: number;
  }): number {
    return this.db.transaction(() => {
      const message = this.db
        .prepare("INSERT INTO transcript(role, provider, chat_id, content) VALUES ('user', NULL, ?, ?)")
        .run(input.chatId, input.prompt);
      const job = this.db
        .prepare(
          `INSERT INTO jobs
            (update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, mode, attachments_json, status, retry_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          input.updateId,
          input.telegramMessageId,
          input.chatId,
          Number(message.lastInsertRowid),
          input.provider,
          input.prompt,
          input.mode ?? "normal",
          JSON.stringify(input.attachments),
          input.retryOf ?? null,
        );
      return Number(job.lastInsertRowid);
    })();
  }

  enqueueInboundJob(input: {
    updateId: number;
    telegramMessageId: number;
    chatId: number;
    userId: number;
    provider: ProviderName;
    prompt: string;
    body: string;
    attachments: RemoteAttachment[];
    mode?: import("./types.js").JobMode;
  }): { fresh: boolean; jobId?: number } {
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO inbound_updates
            (update_id, telegram_message_id, chat_id, user_id, body)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.updateId, input.telegramMessageId, input.chatId, input.userId, input.body);
      if (inserted.changes === 0) {
        return { fresh: false, jobId: this.getJobByUpdate(input.updateId)?.id };
      }
      const message = this.db
        .prepare("INSERT INTO transcript(role, provider, chat_id, content) VALUES ('user', NULL, ?, ?)")
        .run(input.chatId, input.prompt);
      const job = this.db
        .prepare(
          `INSERT INTO jobs
            (update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, mode, attachments_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
        )
        .run(
          input.updateId,
          input.telegramMessageId,
          input.chatId,
          Number(message.lastInsertRowid),
          input.provider,
          input.prompt,
          input.mode ?? "normal",
          JSON.stringify(input.attachments),
        );
      return { fresh: true, jobId: Number(job.lastInsertRowid) };
    })();
  }

  enqueueLiveCodexMessage(input: {
    updateId: number;
    telegramMessageId: number;
    chatId: number;
    userId: number;
    prompt: string;
    body: string;
    model?: string;
  }): { fresh: boolean; action: "start" | "steer"; jobId?: number } {
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO inbound_updates
            (update_id, telegram_message_id, chat_id, user_id, body)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.updateId, input.telegramMessageId, input.chatId, input.userId, input.body);
      if (inserted.changes === 0) return { fresh: false, action: "steer" as const };

      const message = this.db
        .prepare("INSERT INTO transcript(role, provider, chat_id, content) VALUES ('user', NULL, ?, ?)")
        .run(input.chatId, input.prompt);
      const transcriptId = Number(message.lastInsertRowid);
      const conversation = this.getLiveConversation(input.chatId);
      if (conversation && conversation.state !== "idle") {
        this.db
          .prepare(
            `INSERT INTO live_steer_messages(chat_id, update_id, telegram_message_id, transcript_id, prompt)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.chatId, input.updateId, input.telegramMessageId, transcriptId, input.prompt);
        this.db
          .prepare(
            `UPDATE live_conversations
             SET steering_count = steering_count + 1, updated_at = CURRENT_TIMESTAMP
             WHERE chat_id = ?`,
          )
          .run(input.chatId);
        return { fresh: true, action: "steer" as const };
      }

      const job = this.db
        .prepare(
          `INSERT INTO jobs
            (update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, attachments_json, status)
           VALUES (?, ?, ?, ?, 'codex', ?, '[]', 'running')`,
        )
        .run(
          input.updateId,
          input.telegramMessageId,
          input.chatId,
          transcriptId,
          input.prompt,
        );
      const jobId = Number(job.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO live_conversations
            (chat_id, state, active_turn_id, active_job_id, model, steering_count, updated_at)
           VALUES (?, 'starting', NULL, ?, ?, 0, CURRENT_TIMESTAMP)
           ON CONFLICT(chat_id) DO UPDATE SET
             state = 'starting',
             active_turn_id = NULL,
             active_job_id = excluded.active_job_id,
             model = excluded.model,
             steering_count = 0,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(input.chatId, jobId, input.model ?? null);
      return { fresh: true, action: "start" as const, jobId };
    })();
  }

  retryJob(jobId: number, updateId: number, telegramMessageId: number): number | undefined {
    const original = this.getJob(jobId);
    if (!original || !["failed", "canceled", "interrupted"].includes(original.status)) {
      return undefined;
    }
    return this.enqueueJob({
      updateId,
      telegramMessageId,
      chatId: original.chat_id,
      provider: original.provider,
      prompt: original.prompt,
      attachments: JSON.parse(original.attachments_json) as RemoteAttachment[],
      mode: original.mode,
      retryOf: original.id,
    });
  }

  recordAndRetryJob(input: {
    requestedJobId: number;
    updateId: number;
    telegramMessageId: number;
    chatId: number;
    userId: number;
    body: string;
  }): { fresh: boolean; jobId?: number } {
    return this.db.transaction(() => {
      const fresh = this.recordUpdate(
        input.updateId,
        input.telegramMessageId,
        input.chatId,
        input.userId,
        input.body,
      );
      if (!fresh) return { fresh: false, jobId: this.getJobByUpdate(input.updateId)?.id };
      return {
        fresh: true,
        jobId: this.retryJob(input.requestedJobId, input.updateId, input.telegramMessageId),
      };
    })();
  }

  getJob(id: number): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  hasPendingAttachmentJob(chatId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found
         FROM jobs
         WHERE chat_id = ?
           AND status IN ('queued', 'running')
           AND attachments_json != '[]'
         LIMIT 1`,
      )
      .get(chatId) as { found: number } | undefined;
    return Boolean(row);
  }

  recordJobDiagnostic(
    jobId: number,
    event: JobDiagnosticEvent,
    details: JobDiagnosticDetails,
  ): void {
    validateJobDiagnostic(event, details);
    this.db
      .prepare("INSERT INTO job_diagnostics(job_id, event, details_json) VALUES (?, ?, ?)")
      .run(jobId, event, JSON.stringify(details));
  }

  getJobDiagnostics(jobId: number): Array<{
    event: string;
    details: JobDiagnosticDetails;
    created_at: string;
  }> {
    return (this.db
      .prepare("SELECT event, details_json, created_at FROM job_diagnostics WHERE job_id = ? ORDER BY id")
      .all(jobId) as Array<{ event: string; details_json: string; created_at: string }>)
      .flatMap((row) => {
        try {
          const details = JSON.parse(row.details_json);
          if (!details || typeof details !== "object" || Array.isArray(details)) return [];
          return [{
            event: row.event,
            details: details as JobDiagnosticDetails,
            created_at: row.created_at,
          }];
        } catch {
          return [];
        }
      });
  }

  getInboundUpdateBody(updateId: number): string | undefined {
    const row = this.db
      .prepare("SELECT body FROM inbound_updates WHERE update_id = ?")
      .get(updateId) as { body: string } | undefined;
    return row?.body;
  }

  getJobByUpdate(updateId: number): JobRow | undefined {
    return this.db
      .prepare("SELECT * FROM jobs WHERE update_id = ? ORDER BY id DESC LIMIT 1")
      .get(updateId) as JobRow | undefined;
  }

  getLiveConversation(chatId: number): LiveConversationRow | undefined {
    return this.db
      .prepare("SELECT * FROM live_conversations WHERE chat_id = ?")
      .get(chatId) as LiveConversationRow | undefined;
  }

  setLiveConversationTurn(
    chatId: number,
    jobId: number,
    threadId: string,
    turnId: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE live_conversations
           SET state = 'running', thread_id = ?, active_turn_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE chat_id = ? AND active_job_id = ?`,
        )
        .run(threadId, turnId, chatId, jobId).changes === 1
    );
  }

  nextLiveSteer(chatId: number): LiveSteerRow | undefined {
    return this.db
      .prepare(
        `SELECT id, chat_id, update_id, telegram_message_id, transcript_id, prompt, created_at
         FROM live_steer_messages
         WHERE chat_id = ? AND status = 'pending'
         ORDER BY id LIMIT 1`,
      )
      .get(chatId) as LiveSteerRow | undefined;
  }

  markLiveSteerSent(id: number): void {
    this.db
      .prepare("UPDATE live_steer_messages SET status = 'sent' WHERE id = ?")
      .run(id);
  }

  startPendingLiveFollowup(chatId: number): { jobId?: number } {
    return this.db.transaction(() => {
      const conversation = this.getLiveConversation(chatId);
      if (!conversation || conversation.state !== "idle") return {};
      const steer = this.nextLiveSteer(chatId);
      if (!steer) return {};
      const job = this.db
        .prepare(
          `INSERT INTO jobs
            (update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, attachments_json, status)
           VALUES (?, ?, ?, ?, 'codex', ?, '[]', 'running')`,
        )
        .run(
          steer.update_id,
          steer.telegram_message_id,
          chatId,
          steer.transcript_id,
          steer.prompt,
        );
      const jobId = Number(job.lastInsertRowid);
      this.markLiveSteerSent(steer.id);
      this.db
        .prepare(
          `UPDATE live_conversations
           SET state = 'starting', active_turn_id = NULL, active_job_id = ?,
             steering_count = 0, updated_at = CURRENT_TIMESTAMP
           WHERE chat_id = ?`,
        )
        .run(jobId, chatId);
      return { jobId };
    })();
  }

  finishLiveConversation(chatId: number, jobId: number, clearThread = false): boolean {
    return (
      this.db
        .prepare(
          `UPDATE live_conversations
           SET state = 'idle', thread_id = CASE WHEN ? THEN NULL ELSE thread_id END,
             active_turn_id = NULL, active_job_id = NULL,
             steering_count = 0, updated_at = CURRENT_TIMESTAMP
           WHERE chat_id = ? AND active_job_id = ?`,
        )
        .run(clearThread ? 1 : 0, chatId, jobId).changes === 1
    );
  }

  failLiveConversation(
    chatId: number,
    jobId: number,
    status: "failed" | "canceled",
    error: string,
    resetThread = false,
  ): boolean {
    return this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE live_conversations
           SET state = 'idle', active_turn_id = NULL, active_job_id = NULL,
             thread_id = CASE WHEN ? THEN NULL ELSE thread_id END,
             steering_count = 0, updated_at = CURRENT_TIMESTAMP
           WHERE chat_id = ? AND active_job_id = ?`,
        )
        .run(resetThread ? 1 : 0, chatId, jobId).changes;
      if (!updated) return false;
      this.failJob(jobId, status, error);
      if (resetThread) {
        this.db.prepare("DELETE FROM live_steer_messages WHERE chat_id = ?").run(chatId);
        this.taintProvider("codex");
      }
      return true;
    })();
  }

  resetLiveConversation(
    chatId: number,
    taintProvider = true,
  ): { threadId?: string; turnId?: string; jobId?: number } {
    return this.db.transaction(() => {
      const conversation = this.getLiveConversation(chatId);
      if (!conversation) return {};
      if (conversation.active_job_id) {
        this.failJob(conversation.active_job_id, "canceled", "Session reset by user.");
      }
      this.db
        .prepare(
          `UPDATE live_conversations
           SET state = 'idle', thread_id = NULL, active_turn_id = NULL, active_job_id = NULL,
             steering_count = 0, updated_at = CURRENT_TIMESTAMP
           WHERE chat_id = ?`,
        )
        .run(chatId);
      this.db.prepare("DELETE FROM live_steer_messages WHERE chat_id = ?").run(chatId);
      if (taintProvider) this.taintProvider("codex");
      return {
        ...(conversation.thread_id ? { threadId: conversation.thread_id } : {}),
        ...(conversation.active_turn_id ? { turnId: conversation.active_turn_id } : {}),
        ...(conversation.active_job_id ? { jobId: conversation.active_job_id } : {}),
      };
    })();
  }

  recoverLiveConversations(): number {
    return this.db.transaction(() => {
      const running = this.db
        .prepare(
          `SELECT active_job_id FROM live_conversations
           WHERE state IN ('starting', 'running') AND active_job_id IS NOT NULL`,
        )
        .all() as Array<{ active_job_id: number }>;
      for (const { active_job_id } of running) {
        this.failJob(
          active_job_id,
          "canceled",
          "Service restarted while the live Codex turn was running; send a new message to continue.",
        );
      }
      if (running.length) this.taintProvider("codex");
      this.db
        .prepare(
          `UPDATE live_conversations
           SET state = 'idle', active_turn_id = NULL, active_job_id = NULL,
             steering_count = 0, updated_at = CURRENT_TIMESTAMP
           WHERE state IN ('starting', 'running')`,
        )
        .run();
      return running.length;
    })();
  }

  claimNextJob(): JobRow | undefined {
    return this.db.transaction(() => {
      const job = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1")
        .get() as JobRow | undefined;
      if (!job) return undefined;
      this.db
        .prepare("UPDATE jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(job.id);
      return this.getJob(job.id);
    })();
  }

  recoverInterruptedJobs(): number {
    return this.db.transaction(() => {
      const providers = this.db
        .prepare("SELECT DISTINCT provider FROM jobs WHERE status = 'running'")
        .all() as Array<{ provider: ProviderName }>;
      for (const { provider } of providers) this.taintProvider(provider);
      const recovered = this.db
        .prepare(
          `UPDATE jobs SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP,
            error = 'Service restarted while the agent was running; use /retry to run it again.',
            process_pid = NULL
           WHERE status = 'running'`,
        )
        .run().changes;
      if (recovered) {
        this.db
          .prepare(
            "DELETE FROM job_processes WHERE job_id IN (SELECT id FROM jobs WHERE status = 'interrupted')",
          )
          .run();
      }
      return recovered;
    })();
  }

  completeJob(
    id: number,
    resultText: string,
    provider: ProviderName,
    sessionId: string | null,
    outbound: OutboxInput[] = [],
    metrics?: JobMetrics,
  ): number {
    return this.db.transaction(() => {
      const job = this.getJob(id);
      if (!job) throw new Error(`Cannot complete missing job ${id}.`);
      const assistant = this.db
        .prepare("INSERT INTO transcript(role, provider, chat_id, content) VALUES ('assistant', ?, ?, ?)")
        .run(provider, job.chat_id, resultText);
      const messageId = Number(assistant.lastInsertRowid);
      this.db
        .prepare(
          `UPDATE jobs SET status = 'completed', result_text = ?, finished_at = CURRENT_TIMESTAMP,
            error = NULL, process_pid = NULL, model = ?, requested_model = ?, fallback_reason = ?, cost_usd = ?, cost_credits = ?,
            input_tokens = ?, cached_input_tokens = ?, output_tokens = ?, usage_recorded_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          resultText,
          metrics?.model ?? null,
          metrics?.requestedModel ?? null,
          metrics?.fallbackReason ?? null,
          metrics?.costUsd ?? null,
          metrics?.codexCredits ?? null,
          metrics?.usage?.inputTokens ?? null,
          metrics?.usage?.cachedInputTokens ?? null,
          metrics?.usage?.outputTokens ?? null,
          id,
        );
      this.db.prepare("DELETE FROM job_processes WHERE job_id = ?").run(id);
      this.db
        .prepare(
          `UPDATE provider_sessions SET session_id = ?, last_message_id = ?, tainted = 0
           WHERE provider = ?`,
        )
        .run(sessionId, messageId, provider);
      const outboxStatement = this.db.prepare(
        "INSERT INTO outbox(job_id, chat_id, kind, payload_json) VALUES (?, ?, ?, ?)",
      );
      const attachmentStatement = this.db.prepare(
        `INSERT INTO transcript_attachments
          (transcript_id, outbox_id, ordinal, file_name, media_type, caption, sha256, provenance, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let attachmentOrdinal = 0;
      for (const item of outbound) {
        const outbox = outboxStatement.run(id, item.chatId, item.kind, JSON.stringify(item.payload));
        if (item.media) {
          attachmentOrdinal += 1;
          attachmentStatement.run(
            messageId,
            Number(outbox.lastInsertRowid),
            attachmentOrdinal,
            item.media.fileName,
            item.media.mediaType,
            item.media.caption ?? null,
            item.media.sha256,
            item.media.provenance,
            item.media.sourceUrl ?? null,
          );
        }
      }
      return messageId;
    })();
  }

  failJob(
    id: number,
    status: "failed" | "canceled",
    error: string,
    metrics?: JobMetrics,
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP, process_pid = NULL,
          model = ?, requested_model = ?, fallback_reason = ?, cost_usd = ?, cost_credits = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
          usage_recorded_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(
        status,
        error,
        metrics?.model ?? null,
        metrics?.requestedModel ?? null,
        metrics?.fallbackReason ?? null,
        metrics?.costUsd ?? null,
        metrics?.codexCredits ?? null,
        metrics?.usage?.inputTokens ?? null,
        metrics?.usage?.cachedInputTokens ?? null,
        metrics?.usage?.outputTokens ?? null,
        id,
      );
    this.db.prepare("DELETE FROM job_processes WHERE job_id = ?").run(id);
  }

  costSummary(since?: string): CostSummary {
    const rows = this.db
      .prepare(
        `SELECT
           provider,
           COUNT(*) AS jobs,
           SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced_jobs,
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           SUM(CASE WHEN cost_credits IS NOT NULL THEN 1 ELSE 0 END) AS credited_jobs,
           COALESCE(SUM(cost_credits), 0) AS cost_credits,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM jobs
         WHERE usage_recorded_at IS NOT NULL
           AND (? IS NULL OR finished_at >= ?)
         GROUP BY provider`,
      )
      .all(since ?? null, since ?? null) as Array<{
      provider: ProviderName;
      jobs: number;
      priced_jobs: number;
      cost_usd: number;
      credited_jobs: number;
      cost_credits: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    }>;
    const emptyProvider = (): CostProviderSummary => ({
      jobs: 0,
      pricedJobs: 0,
      costUsd: 0,
      creditedJobs: 0,
      codexCredits: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    });
    const providers: Record<ProviderName, CostProviderSummary> = {
      codex: emptyProvider(),
      claude: emptyProvider(),
    };
    for (const row of rows) {
      providers[row.provider] = {
        jobs: row.jobs,
        pricedJobs: row.priced_jobs,
        costUsd: row.cost_usd,
        creditedJobs: row.credited_jobs,
        codexCredits: row.cost_credits,
        usage: {
          inputTokens: row.input_tokens,
          cachedInputTokens: row.cached_input_tokens,
          outputTokens: row.output_tokens,
        },
      };
    }
    return {
      jobs: rows.reduce((sum, row) => sum + row.jobs, 0),
      pricedJobs: rows.reduce((sum, row) => sum + row.priced_jobs, 0),
      costUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
      creditedJobs: rows.reduce((sum, row) => sum + row.credited_jobs, 0),
      codexCredits: rows.reduce((sum, row) => sum + row.cost_credits, 0),
      providers,
    };
  }

  setJobProcessPid(id: number, pid: number): void {
    this.db.prepare("UPDATE jobs SET process_pid = ? WHERE id = ? AND status = 'running'").run(pid, id);
  }

  addJobProcess(jobId: number, pid: number, kind: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO job_processes(job_id, pid, kind) VALUES (?, ?, ?)")
      .run(jobId, pid, kind);
  }

  removeJobProcess(jobId: number, pid: number): void {
    this.db.prepare("DELETE FROM job_processes WHERE job_id = ? AND pid = ?").run(jobId, pid);
  }

  runningProcessPids(): number[] {
    const parent = this.db
      .prepare("SELECT process_pid AS pid FROM jobs WHERE status = 'running' AND process_pid IS NOT NULL")
      .all() as Array<{ pid: number }>;
    const children = this.db
      .prepare(
        `SELECT job_processes.pid FROM job_processes
         JOIN jobs ON jobs.id = job_processes.job_id
         WHERE jobs.status = 'running'`,
      )
      .all() as Array<{ pid: number }>;
    return [...new Set([...parent, ...children].map((row) => row.pid))];
  }

  taintProvider(provider: ProviderName): void {
    this.db
      .prepare("UPDATE provider_sessions SET session_id = NULL, tainted = 1 WHERE provider = ?")
      .run(provider);
  }

  resetProvider(provider: ProviderName): void {
    const latest = this.latestTranscriptId();
    this.db
      .prepare(
        "UPDATE provider_sessions SET session_id = NULL, last_message_id = ?, tainted = 0 WHERE provider = ?",
      )
      .run(latest, provider);
  }

  getProviderSession(provider: ProviderName): ProviderSessionRow {
    return this.db
      .prepare("SELECT * FROM provider_sessions WHERE provider = ?")
      .get(provider) as ProviderSessionRow;
  }

  searchHistory(query: string, chatId: number, limit = 5, beforeTranscriptId?: number): Array<{
    id: number;
    role: string;
    provider: string | null;
    created_at: string;
    snippet: string;
    media_count: number;
  }> {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/g) ?? [])];
    if (!terms.length) return [];
    const ftsQuery = terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" AND ");
    return this.db
      .prepare(
        `SELECT transcript.id, transcript.role, transcript.provider, transcript.created_at,
                snippet(transcript_fts, 0, '[', ']', '…', 16) AS snippet,
                (SELECT COUNT(*) FROM transcript_attachments WHERE transcript_id = transcript.id) AS media_count
         FROM transcript_fts
         JOIN transcript ON transcript.id = transcript_fts.rowid
         WHERE transcript_fts MATCH ?
         ${beforeTranscriptId ? "AND transcript.id < ?" : ""}
         AND transcript.chat_id = ?
         ORDER BY bm25(transcript_fts), transcript.id DESC
         LIMIT ?`,
      )
      .all(ftsQuery, ...(beforeTranscriptId ? [beforeTranscriptId] : []), chatId, limit) as Array<{
      id: number;
      role: string;
      provider: string | null;
      created_at: string;
      snippet: string;
      media_count: number;
    }>;
  }

  recentHistory(chatId: number, limit = 5, beforeTranscriptId?: number): Array<{
    id: number;
    role: string;
    provider: string | null;
    created_at: string;
    snippet: string;
    media_count: number;
  }> {
    return this.db
      .prepare(
        `SELECT transcript.id, transcript.role, transcript.provider, transcript.created_at,
                substr(replace(replace(transcript.content, char(10), ' '), char(13), ' '), 1, 480) AS snippet,
                (SELECT COUNT(*) FROM transcript_attachments WHERE transcript_id = transcript.id) AS media_count
         FROM transcript
         WHERE 1 = 1
         ${beforeTranscriptId ? "AND id < ?" : ""}
         AND chat_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...(beforeTranscriptId ? [beforeTranscriptId] : []), chatId, limit) as Array<{
      id: number;
      role: string;
      provider: string | null;
      created_at: string;
      snippet: string;
      media_count: number;
    }>;
  }

  recentHistoryWithMedia(chatId: number, limit = 5, beforeTranscriptId?: number): number[] {
    return this.db
      .prepare(
        `SELECT transcript.id
         FROM transcript
         WHERE transcript.chat_id = ?
         ${beforeTranscriptId ? "AND transcript.id < ?" : ""}
         AND EXISTS (
           SELECT 1 FROM transcript_attachments
           WHERE transcript_attachments.transcript_id = transcript.id
         )
         ORDER BY transcript.id DESC
         LIMIT ?`,
      )
      .all(chatId, ...(beforeTranscriptId ? [beforeTranscriptId] : []), limit)
      .map((row) => (row as { id: number }).id);
  }

  readHistory(ids: number[], chatId: number, maxChars = 8_000): Array<{
    id: number;
    role: string;
    provider: string | null;
    created_at: string;
    content: string;
    truncated: boolean;
    attachments: Array<{
      fileName: string;
      mediaType: string;
      caption: string | null;
      provenance: string;
      sourceUrl: string | null;
      deliveryStatus: "pending" | "sending" | "sent";
      telegramMessageId: number | null;
    }>;
  }> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, role, provider, created_at, content
         FROM transcript WHERE id IN (${placeholders}) AND chat_id = ?`,
      )
      .all(...ids, chatId) as Array<{
      id: number;
      role: string;
      provider: string | null;
      created_at: string;
      content: string;
    }>;
    const attachments = this.db
      .prepare(
        `SELECT transcript_attachments.transcript_id, transcript_attachments.file_name, transcript_attachments.media_type,
                transcript_attachments.caption, transcript_attachments.provenance, transcript_attachments.source_url,
                outbox.status, outbox.telegram_message_id
         FROM transcript_attachments
         JOIN outbox ON outbox.id = transcript_attachments.outbox_id
         WHERE transcript_attachments.transcript_id IN (${placeholders})
         ORDER BY transcript_attachments.transcript_id, transcript_attachments.ordinal`,
      )
      .all(...ids) as Array<{
      transcript_id: number;
      file_name: string;
      media_type: string;
      caption: string | null;
      provenance: string;
      source_url: string | null;
      status: "pending" | "sending" | "sent";
      telegram_message_id: number | null;
    }>;
    const attachmentsByTranscript = new Map<number, Array<{
      fileName: string;
      mediaType: string;
      caption: string | null;
      provenance: string;
      sourceUrl: string | null;
      deliveryStatus: "pending" | "sending" | "sent";
      telegramMessageId: number | null;
    }>>();
    for (const attachment of attachments) {
      const items = attachmentsByTranscript.get(attachment.transcript_id) ?? [];
      items.push({
        fileName: attachment.file_name,
        mediaType: attachment.media_type,
        caption: attachment.caption,
        provenance: attachment.provenance,
        sourceUrl: attachment.source_url,
        deliveryStatus: attachment.status,
        telegramMessageId: attachment.telegram_message_id,
      });
      attachmentsByTranscript.set(attachment.transcript_id, items);
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      return [
        {
          ...row,
          content: row.content.slice(0, maxChars),
          truncated: row.content.length > maxChars,
          attachments: attachmentsByTranscript.get(id) ?? [],
        },
      ];
    });
  }

  private latestTranscriptId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM transcript").get() as {
      id: number;
    };
    return row.id;
  }

  status(): { running?: JobRow; queued: number; interrupted: number; retryable?: JobRow } {
    const running = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY id LIMIT 1")
      .get() as JobRow | undefined;
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted
         FROM jobs`,
      )
      .get() as { queued: number | null; interrupted: number | null };
    const retryable = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('failed', 'canceled', 'interrupted')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as JobRow | undefined;
    return { running, queued: counts.queued ?? 0, interrupted: counts.interrupted ?? 0, retryable };
  }

  recordOutbound(telegramMessageId: number, jobId: number | null, kind: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbound_messages(telegram_message_id, job_id, kind) VALUES (?, ?, ?)",
      )
      .run(telegramMessageId, jobId, kind);
  }

  claimNextOutbox(): OutboxRow | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM outbox
           WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP
             AND NOT EXISTS (
               SELECT 1 FROM outbox earlier
               WHERE earlier.job_id = outbox.job_id
                 AND earlier.id < outbox.id
                 AND earlier.status != 'sent'
             )
           ORDER BY id LIMIT 1`,
        )
        .get() as OutboxRow | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(row.id);
      return { ...row, status: "sending" as const };
    })();
  }

  recoverOutbox(): number {
    return this.db
      .prepare("UPDATE outbox SET status = 'pending' WHERE status = 'sending'")
      .run().changes;
  }

  completeOutbox(id: number, telegramMessageId: number): void {
    this.db
      .prepare(
        `UPDATE outbox SET status = 'sent', telegram_message_id = ?, sent_at = CURRENT_TIMESTAMP,
          last_error = NULL WHERE id = ?`,
      )
      .run(telegramMessageId, id);
  }

  retryOutbox(id: number, error: string): void {
    const row = this.db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(id) as {
      attempts: number;
    };
    const attempts = row.attempts + 1;
    const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
    this.db
      .prepare(
        `UPDATE outbox SET status = 'pending', attempts = ?, last_error = ?,
          available_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`,
      )
      .run(attempts, error, delaySeconds, id);
  }

  pendingOutboxCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE status != 'sent'")
      .get() as { count: number };
    return row.count;
  }
}

function validateJobDiagnostic(event: JobDiagnosticEvent, details: JobDiagnosticDetails): void {
  if (!DIAGNOSTIC_EVENTS.includes(event)) throw new Error(`Unsupported diagnostic event: ${event}`);
  for (const [key, value] of Object.entries(details)) {
    if (key.split("_").some((part) => ["body", "content", "message", "path", "prompt", "reply", "text"].includes(part))) {
      throw new Error(`Diagnostic key may not contain private message content: ${key}`);
    }
    const isAttachmentHashList = typeof value === "string" &&
      key === "attachment_sha256" && /^[a-f0-9]{64}(,[a-f0-9]{64})*$/.test(value);
    if (typeof value === "string" && ((isAttachmentHashList ? value.length > 649 : value.length > 128) || /[\r\n]/.test(value))) {
      throw new Error(`Diagnostic string is not safely bounded: ${key}`);
    }
  }
}

function mediaTypeForFileName(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
