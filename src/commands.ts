import type { ProviderName } from "./types.js";

export type ParsedCommand =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "switch"; provider: ProviderName }
  | { kind: "new"; target: ProviderName | "all" }
  | { kind: "retry"; jobId: number }
  | { kind: "unknown"; name: string };

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "none" };

  const [rawName = "", rawArg = ""] = trimmed.split(/\s+/, 2);
  const name = rawName.toLowerCase().replace(/@[^\s]+$/, "");
  switch (name) {
    case "/start":
      return { kind: "start" };
    case "/help":
      return { kind: "help" };
    case "/status":
      return { kind: "status" };
    case "/stop":
      return { kind: "stop" };
    case "/codex":
      return { kind: "switch", provider: "codex" };
    case "/claude":
      return { kind: "switch", provider: "claude" };
    case "/new": {
      const target = rawArg.toLowerCase();
      if (target === "codex" || target === "claude" || target === "all") {
        return { kind: "new", target };
      }
      return { kind: "unknown", name: "/new" };
    }
    case "/retry": {
      const jobId = Number(rawArg);
      if (Number.isSafeInteger(jobId) && jobId > 0) return { kind: "retry", jobId };
      return { kind: "unknown", name: "/retry" };
    }
    default:
      return { kind: "unknown", name };
  }
}

export const HELP_TEXT = `AIMessenger commands:
/codex — use Codex for new messages
/claude — use Claude for new messages
/status — show the running job and queue
/stop — cancel the running job
/new codex|claude|all — reset agent session history
/retry <job-id> — retry a failed, canceled, or interrupted job
/help — show this list`;
