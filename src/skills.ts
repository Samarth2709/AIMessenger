import fs from "node:fs";
import path from "node:path";

const MAX_SKILL_COUNT = 32;
const MAX_SKILL_BYTES = 32 * 1024;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
}

export interface SkillCatalog {
  skills: AgentSkill[];
  rejected: number;
}

function frontMatterValue(frontMatter: string, key: string): string | undefined {
  const match = frontMatter.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return undefined;
  return match[1]!.replace(/^(["'])(.*)\\1$/, "$2").trim();
}

function parseSkill(skillPath: string, directoryName: string, source: string): AgentSkill | undefined {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const name = frontMatterValue(match[1]!, "name");
  const description = frontMatterValue(match[1]!, "description");
  if (!name || !description || name !== directoryName || !SKILL_NAME.test(name)) return undefined;
  return { name, description: description.slice(0, 500), path: skillPath };
}

export function loadSkills(skillsDir: string): SkillCatalog {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { skills: [], rejected: 0 };
    throw error;
  }

  const skills: AgentSkill[] = [];
  let rejected = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || skills.length >= MAX_SKILL_COUNT) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      const source = fs.readFileSync(skillPath, "utf8");
      if (Buffer.byteLength(source) > MAX_SKILL_BYTES) {
        rejected += 1;
        continue;
      }
      const skill = parseSkill(skillPath, entry.name, source);
      if (!skill) {
        rejected += 1;
        continue;
      }
      skills.push(skill);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") rejected += 1;
    }
  }
  return { skills, rejected };
}

export function renderSkillCatalog(skills: AgentSkill[]): string | undefined {
  if (!skills.length) return undefined;
  const entries = skills
    .map((skill) => `- ${skill.name}: ${skill.description}\n  Read ${skill.path} before using it.`)
    .join("\n");
  return `<available_skills>\nThese are reusable, user-owned workflows. When a request matches a skill description or names a skill, read that skill's SKILL.md before acting and follow its instructions.\n${entries}\n</available_skills>`;
}
