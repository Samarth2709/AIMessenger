import fs from "node:fs";
import path from "node:path";

export type LogContext = Record<string, boolean | number | string | null | undefined>;

export interface AppLogger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, error: unknown, context?: LogContext): void;
}

export function errorContext(error: unknown): LogContext {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    return {
      error_name: error.name,
      ...(typeof code === "string" || typeof code === "number" ? { error_code: code } : {}),
      ...(typeof exitCode === "number" ? { error_exit_code: exitCode } : {}),
    };
  }
  return { error_name: typeof error };
}

export class JsonLogger implements AppLogger {
  private readonly filePath: string;

  constructor(logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(logsDir, 0o700);
    this.filePath = path.join(logsDir, "aimessenger.jsonl");
    fs.closeSync(fs.openSync(this.filePath, "a", 0o600));
    fs.chmodSync(this.filePath, 0o600);
  }

  info(event: string, context: LogContext = {}): void {
    this.write("info", event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.write("warn", event, context);
  }

  error(event: string, error: unknown, context: LogContext = {}): void {
    this.write("error", event, { ...context, ...errorContext(error) });
  }

  private write(level: "info" | "warn" | "error", event: string, context: LogContext): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...context,
    });
    try {
      fs.appendFileSync(this.filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "logger.write_failed",
        ...errorContext(error),
      }));
    }
    console.log(line);
  }
}
