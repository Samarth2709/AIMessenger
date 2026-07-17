import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  CostProviderSummary,
  CostSummary,
  JobRow,
  JobMetrics,
  OutboxInput,
  OutboxRow,
  ProviderName,
  ProviderSessionRow,
  RemoteAttachment,
} from "./types.js";

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
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'canceled', 'interrupted')),
        retry_of INTEGER,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        result_text TEXT,
        process_pid INTEGER,
        cost_usd REAL,
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

      INSERT OR IGNORE INTO provider_sessions(provider) VALUES ('codex'), ('claude');
    `);
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const additions = [
      ["process_pid", "INTEGER"],
      ["cost_usd", "REAL"],
      ["input_tokens", "INTEGER"],
      ["cached_input_tokens", "INTEGER"],
      ["output_tokens", "INTEGER"],
      ["usage_recorded_at", "TEXT"],
    ] as const;
    for (const [name, type] of additions) {
      if (!jobColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
    }
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
    retryOf?: number;
  }): number {
    return this.db.transaction(() => {
      const message = this.db
        .prepare("INSERT INTO transcript(role, provider, content) VALUES ('user', NULL, ?)")
        .run(input.prompt);
      const job = this.db
        .prepare(
          `INSERT INTO jobs
            (update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, attachments_json, status, retry_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          input.updateId,
          input.telegramMessageId,
          input.chatId,
          Number(message.lastInsertRowid),
          input.provider,
          input.prompt,
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
        .prepare("INSERT INTO transcript(role, provider, content) VALUES ('user', NULL, ?)")
        .run(input.prompt);
      const job = this.db
        .prepare(
          `INSERT INTO jobs
            (update_id, telegram_message_id, chat_id, user_message_id, provider, prompt, attachments_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
        )
        .run(
          input.updateId,
          input.telegramMessageId,
          input.chatId,
          Number(message.lastInsertRowid),
          input.provider,
          input.prompt,
          JSON.stringify(input.attachments),
        );
      return { fresh: true, jobId: Number(job.lastInsertRowid) };
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

  getJobByUpdate(updateId: number): JobRow | undefined {
    return this.db
      .prepare("SELECT * FROM jobs WHERE update_id = ? ORDER BY id DESC LIMIT 1")
      .get(updateId) as JobRow | undefined;
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
      return this.db
        .prepare(
          `UPDATE jobs SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP,
            error = 'Service restarted while the agent was running; use /retry to run it again.',
            process_pid = NULL
           WHERE status = 'running'`,
        )
        .run().changes;
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
      const assistant = this.db
        .prepare("INSERT INTO transcript(role, provider, content) VALUES ('assistant', ?, ?)")
        .run(provider, resultText);
      const messageId = Number(assistant.lastInsertRowid);
      this.db
        .prepare(
          `UPDATE jobs SET status = 'completed', result_text = ?, finished_at = CURRENT_TIMESTAMP,
            error = NULL, process_pid = NULL, cost_usd = ?, input_tokens = ?,
            cached_input_tokens = ?, output_tokens = ?, usage_recorded_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          resultText,
          metrics?.costUsd ?? null,
          metrics?.usage?.inputTokens ?? null,
          metrics?.usage?.cachedInputTokens ?? null,
          metrics?.usage?.outputTokens ?? null,
          id,
        );
      this.db
        .prepare(
          `UPDATE provider_sessions SET session_id = ?, last_message_id = ?, tainted = 0
           WHERE provider = ?`,
        )
        .run(sessionId, messageId, provider);
      const outboxStatement = this.db.prepare(
        "INSERT INTO outbox(job_id, chat_id, kind, payload_json) VALUES (?, ?, ?, ?)",
      );
      for (const item of outbound) {
        outboxStatement.run(id, item.chatId, item.kind, JSON.stringify(item.payload));
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
          cost_usd = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
          usage_recorded_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(
        status,
        error,
        metrics?.costUsd ?? null,
        metrics?.usage?.inputTokens ?? null,
        metrics?.usage?.cachedInputTokens ?? null,
        metrics?.usage?.outputTokens ?? null,
        id,
      );
  }

  costSummary(since?: string): CostSummary {
    const rows = this.db
      .prepare(
        `SELECT
           provider,
           COUNT(*) AS jobs,
           SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced_jobs,
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
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
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    }>;
    const emptyProvider = (): CostProviderSummary => ({
      jobs: 0,
      pricedJobs: 0,
      costUsd: 0,
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
      providers,
    };
  }

  setJobProcessPid(id: number, pid: number): void {
    this.db.prepare("UPDATE jobs SET process_pid = ? WHERE id = ? AND status = 'running'").run(pid, id);
  }

  runningProcessPids(): number[] {
    return (
      this.db
        .prepare("SELECT process_pid FROM jobs WHERE status = 'running' AND process_pid IS NOT NULL")
        .all() as Array<{ process_pid: number }>
    ).map((row) => row.process_pid);
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

  getContext(provider: ProviderName, beforeMessageId: number): string {
    const session = this.getProviderSession(provider);
    const bootstrapContext =
      (!session.session_id && session.last_message_id === 0) || session.tainted === 1;
    const completedUserFilter = `(
      role != 'user' OR EXISTS (
        SELECT 1 FROM jobs context_job
        WHERE context_job.user_message_id = transcript.id AND context_job.status = 'completed'
      )
    )`;
    const rows = bootstrapContext
      ? (this.db
          .prepare(
            `SELECT role, provider, content FROM (
               SELECT id, role, provider, content FROM transcript
               WHERE id < ? AND ${completedUserFilter} ORDER BY id DESC LIMIT 20
             ) ORDER BY id`,
          )
          .all(beforeMessageId) as Array<{ role: string; provider: string | null; content: string }>)
      : (this.db
          .prepare(
            `SELECT role, provider, content FROM transcript
             WHERE id > ? AND id < ? AND ${completedUserFilter} ORDER BY id`,
          )
          .all(session.last_message_id, beforeMessageId) as Array<{
          role: string;
          provider: string | null;
          content: string;
        }>);

    const rendered = rows
      .map((row) => `${row.role}${row.provider ? ` (${row.provider})` : ""}: ${row.content}`)
      .join("\n\n");
    return rendered.length > 20_000 ? rendered.slice(-20_000) : rendered;
  }

  private latestTranscriptId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM transcript").get() as {
      id: number;
    };
    return row.id;
  }

  status(): { running?: JobRow; queued: number; interrupted: number } {
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
    return { running, queued: counts.queued ?? 0, interrupted: counts.interrupted ?? 0 };
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
