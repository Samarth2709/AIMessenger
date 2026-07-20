import type { ProviderName } from "./types.js";

export type ParsedCommand =
  | { kind: "none" }
  | { kind: "research"; prompt: string }
  | { kind: "remember"; statement: string }
  | { kind: "forget"; statement: string }
  | { kind: "memory" }
  | { kind: "help" }
  | { kind: "skills" }
  | { kind: "model"; selection?: number }
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "updates" }
  | { kind: "rollback" }
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
    case "/skills":
      return { kind: "skills" };
    case "/research": {
      const prompt = trimmed.slice(rawName.length).trim();
      return prompt ? { kind: "research", prompt } : { kind: "unknown", name: "/research" };
    }
    case "/remember": {
      const statement = trimmed.slice(rawName.length).trim();
      return statement ? { kind: "remember", statement } : { kind: "unknown", name: "/remember" };
    }
    case "/forget": {
      const statement = trimmed.slice(rawName.length).trim();
      return statement ? { kind: "forget", statement } : { kind: "unknown", name: "/forget" };
    }
    case "/memory":
      return { kind: "memory" };
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
/updates — show the active release and last self-update
/rollback — restore the previous healthy release
/cost [days|all] — show provider-reported spend and Codex token usage
/stop — cancel the running job
/new codex|claude|all — reset agent session history
/retry <job-id> — retry a failed, canceled, or interrupted job
/model - list Codex and AI Security models, then reply with a number to select one
/skills — list reusable workflows
/research <question> — run a parallel, source-backed deep-research review
/remember <preference> — save a durable personal preference
/forget <preference> — remove a saved personal preference
/memory — list saved personal preferences
/help — show this list`;
