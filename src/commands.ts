import type { ProviderName } from "./types.js";

export type ParsedCommand =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "skills" }
  | { kind: "model"; selection?: number }
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "updates" }
  | { kind: "rollback" }
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
    case "/skills":
      return { kind: "skills" };
    case "/model": {
      if (!rawArg) return { kind: "model" };
      const argument = trimmed.slice(rawName.length).trim();
      if (/^[1-9]\d*$/.test(argument)) return { kind: "model", selection: Number(argument) };
      return { kind: "unknown", name: "/model" };
    }
    case "/status":
      return { kind: "status" };
    case "/updates":
      return { kind: "updates" };
    case "/rollback":
      return { kind: "rollback" };
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
/updates — show the active release and last self-update
/rollback — restore the previous healthy release
/stop — cancel the running job
/new codex|claude|all — reset agent session history
/retry <job-id> — retry a failed, canceled, or interrupted job
/model - list Codex and AI Security models, then reply with a number to select one
/skills — list reusable workflows
/help — show this list`;
