import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./providers/process.js";
import type { RemoteAttachment } from "./types.js";

const MAX_TRANSCRIPT_CHARS = 12_000;

export interface TranscriptResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments?: Array<{ startSeconds: number; text: string }>;
}

export interface TranscriptionRunner {
  run(input: { inputPath: string; maxSeconds: number; signal: AbortSignal }): Promise<TranscriptResult>;
}

export interface TranscriptionOptions {
  enabled: boolean;
  maxSeconds: number;
  command?: string;
  scriptPath?: string;
  model?: string;
}

class LocalTranscriptionRunner implements TranscriptionRunner {
  constructor(private readonly options: Required<Pick<TranscriptionOptions, "command" | "scriptPath" | "model">>) {}

  async run(input: { inputPath: string; maxSeconds: number; signal: AbortSignal }): Promise<TranscriptResult> {
    if (!fs.existsSync(this.options.command) || !fs.existsSync(this.options.scriptPath)) {
      throw new Error("Local transcription runtime is unavailable.");
    }
    const output = await runProcess(
      this.options.command,
      [this.options.scriptPath, "--input", input.inputPath, "--model", this.options.model, "--max-seconds", String(input.maxSeconds)],
      path.dirname(input.inputPath),
      input.signal,
    );
    const parsed = JSON.parse(output.stdout) as {
      text?: unknown;
      language?: unknown;
      duration_seconds?: unknown;
      segments?: unknown;
    };
    if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("Transcription returned no text.");
    return {
      text: parsed.text.trim(),
      ...(typeof parsed.language === "string" ? { language: parsed.language } : {}),
      ...(typeof parsed.duration_seconds === "number" ? { durationSeconds: parsed.duration_seconds } : {}),
      ...(Array.isArray(parsed.segments)
        ? {
            segments: parsed.segments.flatMap((segment) => {
              if (!segment || typeof segment !== "object") return [];
              const item = segment as { start_seconds?: unknown; text?: unknown };
              return typeof item.start_seconds === "number" && item.start_seconds >= 0 && typeof item.text === "string" && item.text.trim()
                ? [{ startSeconds: item.start_seconds, text: item.text.trim() }]
                : [];
            }),
          }
        : {}),
    };
  }
}

function timestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export class TranscriptionService {
  private readonly runner: TranscriptionRunner;

  constructor(
    private readonly options: TranscriptionOptions,
    runner?: TranscriptionRunner,
  ) {
    this.runner =
      runner ??
      new LocalTranscriptionRunner({
        command: options.command ?? "",
        scriptPath: options.scriptPath ?? "",
        model: options.model ?? "base",
      });
  }

  async transcribe(
    attachments: RemoteAttachment[],
    attachmentPaths: string[],
    signal: AbortSignal,
  ): Promise<{ context?: string; transcribed: number; failed: number }> {
    if (!this.options.enabled) return { transcribed: 0, failed: 0 };
    const entries: string[] = [];
    let failed = 0;
    for (const [index, attachment] of attachments.entries()) {
      const inputPath = attachmentPaths[index];
      if (!inputPath || !/^(?:audio|video)\//.test(attachment.mimeType)) continue;
      try {
        const transcript = await this.runner.run({ inputPath, maxSeconds: this.options.maxSeconds, signal });
        const segments = transcript.segments?.length
          ? transcript.segments.map((segment) => `[${timestamp(segment.startSeconds)}] ${segment.text}`).join("\n")
          : `[00:00] ${transcript.text}`;
        entries.push(`- ${attachment.fileName}${transcript.language ? ` (${transcript.language})` : ""}: ${segments}`.slice(0, MAX_TRANSCRIPT_CHARS));
      } catch (error) {
        if (signal.aborted) throw error;
        failed += 1;
      }
    }
    return {
      ...(entries.length ? { context: entries.join("\n") } : {}),
      transcribed: entries.length,
      failed,
    };
  }
}
