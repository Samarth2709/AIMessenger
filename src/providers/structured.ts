import type { AgentResult } from "../types.js";
import type { ProviderRunInput } from "./types.js";
import { renderSkillCatalog, type AgentSkill } from "../skills.js";

function asAgentResult(value: unknown): AgentResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.message !== "string") return undefined;
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.path !== "string") return [];
        return [
          {
            path: record.path,
            ...(typeof record.caption === "string" ? { caption: record.caption } : {}),
          },
        ];
      })
    : [];
  return { message: candidate.message, attachments };
}

export function parseAgentResult(value: unknown): AgentResult {
  const direct = asAgentResult(value);
  if (direct) return direct;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = asAgentResult(record.structured_output);
    if (nested) return nested;
    if (typeof record.result === "string") return parseAgentResult(record.result);
  }
  if (typeof value === "string") {
    const stripped = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed = asAgentResult(JSON.parse(stripped));
      if (parsed) return parsed;
      return { message: "", attachments: [] };
    } catch {
      if (value.trim()) return { message: value.trim(), attachments: [] };
    }
  }
  return { message: "", attachments: [] };
}

export function buildPrompt(
  identity: string,
  skills: AgentSkill[],
  runtime: Pick<ProviderRunInput, "provider" | "model">,
  prompt: string,
  context: string,
  attachmentPaths: string[],
): string {
  const sections = [identity.trim()];
  const skillCatalog = renderSkillCatalog(skills);
  if (skillCatalog) sections.push(skillCatalog);
  sections.push(`<runtime>\nprovider: ${runtime.provider}\nmodel: ${runtime.model ?? "CLI default (not pinned)"}\n</runtime>`);
  if (context) {
    sections.push(
      `<conversation_context>\nThese are conversation turns that occurred since this provider last ran. Use them for continuity.\n${context}\n</conversation_context>`,
    );
  }
  if (attachmentPaths.length) {
    sections.push(
      `<local_attachments>\n${attachmentPaths.map((file) => `- ${file}`).join("\n")}\n</local_attachments>`,
    );
  }
  sections.push(`<user_request>\n${prompt}\n</user_request>`);
  sections.push(
    `Return a JSON object matching the supplied schema. Put the user-facing answer in "message". Include an absolute local file path in "attachments" only when the user requested that file or it is essential to the result.`,
  );
  return sections.join("\n\n");
}
