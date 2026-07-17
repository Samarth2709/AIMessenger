import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills, renderSkillCatalog } from "../src/skills.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("skills", () => {
  it("discovers standard SKILL.md files and renders a provider-neutral catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-skills-"));
    directories.push(root);
    const skillDir = path.join(root, "research");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: research\ndescription: Research current facts.\n---\n\n# Research\n",
    );

    const catalog = await loadSkills(root);

    expect(catalog).toEqual({
      skills: [{ name: "research", description: "Research current facts.", path: path.join(skillDir, "SKILL.md") }],
      rejected: 0,
    });
    expect(renderSkillCatalog(catalog.skills)).toContain("Read ");
    expect(renderSkillCatalog(catalog.skills)).toContain("research");
  });

  it("ignores malformed skills without blocking valid ones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-skills-"));
    directories.push(root);
    fs.mkdirSync(path.join(root, "valid"));
    fs.mkdirSync(path.join(root, "invalid"));
    fs.writeFileSync(
      path.join(root, "valid", "SKILL.md"),
      "---\nname: valid\ndescription: A valid skill.\n---\n",
    );
    fs.writeFileSync(path.join(root, "invalid", "SKILL.md"), "# Missing front matter\n");

    const catalog = await loadSkills(root);

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["valid"]);
    expect(catalog.rejected).toBe(1);
  });
});
