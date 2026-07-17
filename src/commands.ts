import type { ProviderName } from "./types.js";

export type ParsedCommand =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "cost"; window: "summary" | "all" | "days"; days?: number }
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
    case "/cost": {
      if (!rawArg) return { kind: "cost", window: "summary" };
      if (rawArg.toLowerCase() === "all") return { kind: "cost", window: "all" };
      const days = Number(rawArg);
      if (Number.isSafeInteger(days) && days >= 1 && days <= 3650) {
        return { kind: "cost", window: "days", days };
      }
      return { kind: "unknown", name: "/cost" };
    }
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
/cost [days|all] — show provider-reported spend and Codex token usage
/stop — cancel the running job
/new codex|claude|all — reset agent session history
/retry <job-id> — retry a failed, canceled, or interrupted job
/help — show this list`;
