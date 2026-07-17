import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db.js";
import { MemoryService, memoryToolDefinitions } from "../src/memory.js";

const tempDirs: string[] = [];
let nextUpdateId = 1;

function fixture(): { db: AppDatabase; memory: MemoryService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-memory-"));
  tempDirs.push(dir);
  const databasePath = path.join(dir, "state.sqlite");
  const db = new AppDatabase(databasePath);
  const memory = new MemoryService({
    memoryDir: path.join(dir, "memory"),
    databasePath,
    cliPath: "/opt/aimessenger/dist/src/memory-cli.js",
    db,
  });
  return { db, memory, dir };
}

function enqueueUserJob(db: AppDatabase, prompt: string): number {
  const updateId = nextUpdateId++;
  db.recordUpdate(updateId, updateId + 10_000, updateId + 20_000, updateId + 30_000, prompt);
  return db.enqueueJob({
    updateId,
    telegramMessageId: updateId + 10_000,
    chatId: updateId + 20_000,
    provider: "codex",
    prompt,
    attachments: [],
  });
}

function userSource(db: AppDatabase, jobId: number): string {
  return `inbound_update:${db.getJob(jobId)!.update_id}`;
}

function userDocument(
  pathName: "core/profile.md" | "core/preferences.md",
  sources: string[],
  statements: string[],
): string {
  const profile = pathName === "core/profile.md";
  return `---
kind: ${profile ? "profile" : "preferences"}
scope: user
status: active
created: 2026-07-17T12:00:00.000Z
updated: 2026-07-17T12:00:00.000Z
keywords: [user, ${profile ? "profile" : "preferences"}]
sources: [${sources.join(", ")}]
links: []
---
# ${profile ? "User profile" : "User preferences"}

${statements.map((statement) => `- ${statement}`).join("\n")}
`;
}

afterEach(() => {
  nextUpdateId = 1;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("user Markdown memory vault", () => {
  it("records a directly stated user fact with current-message provenance", () => {
    const { db, memory } = fixture();
    const prompt = "My name is Sam.";
    const jobId = enqueueUserJob(db, prompt);
    const context = memory.contextForJob(jobId);
    expect(context.map).toContain("## User memory");
    expect(context.map).not.toContain("Active projects");
    expect(context.map).not.toContain("conversation_context");
    expect(context.userSource).toBe(userSource(db, jobId));

    const initial = memory.executeTool("memory_read", { path: "core/profile.md" }, jobId) as { revision: string };
    const updated = memory.executeTool(
      "memory_edit",
      {
        path: "core/profile.md",
        document: userDocument("core/profile.md", [context.userSource!], [prompt]),
        evidence: prompt,
        expected_revision: initial.revision,
      },
      jobId,
    ) as { revision: string };
    const searched = memory.executeTool("memory_search", { query: "Sam" }, jobId) as {
      results: Array<{ path: string; status: string }>;
    };
    expect(searched.results).toEqual([
      expect.objectContaining({ path: "core/profile.md", status: "active" }),
    ]);
    const read = memory.executeTool("memory_read", { path: "core/profile.md" }, jobId) as {
      revision: string;
      content: string;
    };
    expect(read.revision).toBe(updated.revision);
    expect(read.content).toContain(prompt);
    expect(memory.verifyHandoffReferences(jobId, ["core/profile.md"])).toBe(true);
  });

  it("accepts only the two user documents with direct current-message evidence", () => {
    const { db, memory } = fixture();
    const prompt = "I prefer concise answers.";
    const jobId = enqueueUserJob(db, prompt);
    const source = userSource(db, jobId);
    memory.contextForJob(jobId);

    expect(() =>
      memory.executeTool(
        "memory_create",
        {
          path: "projects/aimessenger/state.md",
          document: userDocument("core/profile.md", [source], [prompt]),
          evidence: prompt,
        },
        jobId,
      ),
    ).toThrow("Only core/profile.md and core/preferences.md");
    expect(() => memory.executeTool("memory_read", { path: "core/decisions.md" }, jobId)).toThrow(
      "Only core/profile.md and core/preferences.md",
    );
    expect(() => memory.executeTool("memory_supersede", {}, jobId)).toThrow("User memory changes");

    const initial = memory.executeTool("memory_read", { path: "core/preferences.md" }, jobId) as { revision: string };
    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/preferences.md",
          document: userDocument("core/preferences.md", [source, "assistant_message:12"], [prompt]),
          evidence: prompt,
          expected_revision: initial.revision,
        },
        jobId,
      ),
    ).toThrow("may cite only user messages");
    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/preferences.md",
          document: userDocument("core/preferences.md", [source], ["I prefer detailed answers."]),
          evidence: "I prefer detailed answers.",
          expected_revision: initial.revision,
        },
        jobId,
      ),
    ).toThrow("direct excerpt from the current user message");
    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/preferences.md",
          document: userDocument("core/preferences.md", [source], ["sk-abcdefghijklmnopqrstuvwxyz123456"]),
          evidence: prompt,
          expected_revision: initial.revision,
        },
        jobId,
      ),
    ).toThrow("likely secret");
    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/preferences.md",
          document: userDocument("core/preferences.md", [source], [prompt]),
          evidence: prompt,
          expected_revision: "stale",
        },
        jobId,
      ),
    ).toThrow("changed");
  });

  it("rejects ordinary task requests even when they are copied verbatim", () => {
    const { db, memory } = fixture();
    const prompt = "Deploy the gateway.";
    const jobId = enqueueUserJob(db, prompt);
    const source = userSource(db, jobId);
    const initial = memory.executeTool("memory_read", { path: "core/preferences.md" }, jobId) as { revision: string };

    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/preferences.md",
          document: userDocument("core/preferences.md", [source], [prompt]),
          evidence: prompt,
          expected_revision: initial.revision,
        },
        jobId,
      ),
    ).toThrow("profile fact or lasting response/workflow preference");
  });

  it("rejects fact or preference prefixes that contain task content", () => {
    const { db, memory } = fixture();
    const cases: Array<{
      path: "core/profile.md" | "core/preferences.md";
      prompt: string;
    }> = [
      { path: "core/profile.md", prompt: "I'm asking you to deploy the gateway." },
      { path: "core/profile.md", prompt: "My name is Sam; complete the gateway migration." },
      { path: "core/profile.md", prompt: "My name is Sam, delete the database." },
      { path: "core/preferences.md", prompt: "When you finish, deploy the gateway." },
      { path: "core/preferences.md", prompt: "I prefer concise answers; the migration is complete." },
      { path: "core/preferences.md", prompt: "I prefer concise answers, send the report." },
      { path: "core/profile.md", prompt: "I work on sending the quarterly report." },
      { path: "core/preferences.md", prompt: "When I finish the quarterly report ask me to send it." },
    ];

    for (const { path: pathName, prompt } of cases) {
      const jobId = enqueueUserJob(db, prompt);
      const source = userSource(db, jobId);
      const initial = memory.executeTool("memory_read", { path: pathName }, jobId) as { revision: string };
      expect(() =>
        memory.executeTool(
          "memory_edit",
          {
            path: pathName,
            document: userDocument(pathName, [source], [prompt]),
            evidence: prompt,
            expected_revision: initial.revision,
          },
          jobId,
        ),
      ).toThrow("profile fact or lasting response/workflow preference");
    }
  });

  it("rejects quoted or negated evidence that is not a standalone user statement", () => {
    const { db, memory } = fixture();
    const cases: Array<{
      path: "core/profile.md" | "core/preferences.md";
      prompt: string;
      evidence: string;
    }> = [
      { path: "core/profile.md", prompt: "Do not assume my name is Sam.", evidence: "my name is Sam." },
      { path: "core/preferences.md", prompt: "It is false that I prefer concise answers.", evidence: "I prefer concise answers." },
    ];

    for (const { path: pathName, prompt, evidence } of cases) {
      const jobId = enqueueUserJob(db, prompt);
      const source = userSource(db, jobId);
      const initial = memory.executeTool("memory_read", { path: pathName }, jobId) as { revision: string };
      expect(() =>
        memory.executeTool(
          "memory_edit",
          {
            path: pathName,
            document: userDocument(pathName, [source], [evidence]),
            evidence,
            expected_revision: initial.revision,
          },
          jobId,
        ),
      ).toThrow("direct excerpt from the current user message");
    }
  });

  it("requires each source exactly once when growing user memory", () => {
    const { db, memory } = fixture();
    const firstPrompt = "I prefer concise answers.";
    const firstJob = enqueueUserJob(db, firstPrompt);
    const firstSource = userSource(db, firstJob);
    const initial = memory.executeTool("memory_read", { path: "core/preferences.md" }, firstJob) as { revision: string };
    memory.executeTool(
      "memory_edit",
      {
        path: "core/preferences.md",
        document: userDocument("core/preferences.md", [firstSource], [firstPrompt]),
        evidence: firstPrompt,
        expected_revision: initial.revision,
      },
      firstJob,
    );

    const secondPrompt = "I prefer direct answers.";
    const secondJob = enqueueUserJob(db, secondPrompt);
    const secondSource = userSource(db, secondJob);
    const current = memory.executeTool("memory_read", { path: "core/preferences.md" }, secondJob) as { revision: string };
    for (const sources of [[firstSource, firstSource], [secondSource, secondSource]]) {
      expect(() =>
        memory.executeTool(
          "memory_edit",
          {
            path: "core/preferences.md",
            document: userDocument("core/preferences.md", sources, [firstPrompt, secondPrompt]),
            evidence: secondPrompt,
            expected_revision: current.revision,
          },
          secondJob,
        ),
      ).toThrow("must include");
    }
  });

  it("grows user memory by preserving earlier direct statements and sources", () => {
    const { db, memory } = fixture();
    const firstPrompt = "My name is Sam.";
    const firstJob = enqueueUserJob(db, firstPrompt);
    const firstSource = userSource(db, firstJob);
    const initial = memory.executeTool("memory_read", { path: "core/profile.md" }, firstJob) as { revision: string };
    memory.executeTool(
      "memory_edit",
      {
        path: "core/profile.md",
        document: userDocument("core/profile.md", [firstSource], [firstPrompt]),
        evidence: firstPrompt,
        expected_revision: initial.revision,
      },
      firstJob,
    );

    const secondPrompt = "I work in AI security.";
    const secondJob = enqueueUserJob(db, secondPrompt);
    const secondSource = userSource(db, secondJob);
    const current = memory.executeTool("memory_read", { path: "core/profile.md" }, secondJob) as {
      revision: string;
    };
    memory.executeTool(
      "memory_edit",
      {
        path: "core/profile.md",
        document: userDocument("core/profile.md", [firstSource, secondSource], [firstPrompt, secondPrompt]),
        evidence: secondPrompt,
        expected_revision: current.revision,
      },
      secondJob,
    );
    const profile = memory.executeTool("memory_read", { path: "core/profile.md" }, secondJob) as { content: string };
    expect(profile.content).toContain(firstPrompt);
    expect(profile.content).toContain(secondPrompt);
    expect(profile.content).toContain(firstSource);
    expect(profile.content).toContain(secondSource);
  });

  it("disables semantic writes for retries and attachment-only jobs", () => {
    const { db, memory } = fixture();
    const originalJob = enqueueUserJob(db, "My name is Sam.");
    db.failJob(originalJob, "failed", "retry test");
    const retryUpdateId = 90_000;
    const retry = db.recordAndRetryJob({
      requestedJobId: originalJob,
      updateId: retryUpdateId,
      telegramMessageId: retryUpdateId + 1,
      chatId: retryUpdateId + 2,
      userId: retryUpdateId + 3,
      body: `/retry ${originalJob}`,
    });
    const retryJob = retry.jobId!;
    expect(memory.contextForJob(retryJob).userSource).toBeUndefined();
    const retryProfile = memory.executeTool("memory_read", { path: "core/profile.md" }, retryJob) as { revision: string };
    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/profile.md",
          document: userDocument("core/profile.md", [`inbound_update:${retryUpdateId}`], ["My name is Sam."]),
          evidence: "My name is Sam.",
          expected_revision: retryProfile.revision,
        },
        retryJob,
      ),
    ).toThrow("unavailable for retries");

    const attachmentUpdateId = 91_000;
    const attachment = db.enqueueInboundJob({
      updateId: attachmentUpdateId,
      telegramMessageId: attachmentUpdateId + 1,
      chatId: attachmentUpdateId + 2,
      userId: attachmentUpdateId + 3,
      provider: "codex",
      prompt: "Inspect the attached file and report the useful findings.",
      body: "",
      attachments: [],
    });
    const attachmentJob = attachment.jobId!;
    expect(memory.contextForJob(attachmentJob).userSource).toBeUndefined();
    const attachmentProfile = memory.executeTool("memory_read", { path: "core/profile.md" }, attachmentJob) as { revision: string };
    expect(() =>
      memory.executeTool(
        "memory_edit",
        {
          path: "core/profile.md",
          document: userDocument("core/profile.md", [`inbound_update:${attachmentUpdateId}`], ["Inspect the attached file and report the useful findings."]),
          evidence: "Inspect the attached file and report the useful findings.",
          expected_revision: attachmentProfile.revision,
        },
        attachmentJob,
      ),
    ).toThrow("attachment-only requests");
  });

  it("quarantines unsupported or unproven legacy core memory before it can be retrieved", () => {
    const { db, memory, dir } = fixture();
    const jobId = enqueueUserJob(db, "Deploy the gateway.");
    const profilePath = path.join(dir, "memory", "core", "profile.md");
    const preferencesPath = path.join(dir, "memory", "core", "preferences.md");
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(
      profilePath,
      `---
kind: profile
scope: user
status: active
created: 2026-07-17T12:00:00.000Z
updated: 2026-07-17T12:00:00.000Z
keywords: [legacy]
sources: [${userSource(db, jobId)}]
links: []
---
# User profile

- Deploy the gateway.
`,
    );
    fs.writeFileSync(
      preferencesPath,
      `---
kind: preferences
scope: user
status: active
created: 2026-07-17T12:00:00.000Z
updated: 2026-07-17T12:00:00.000Z
keywords: [legacy]
sources: [inbound_update:999999]
links: []
---
# User preferences

- I prefer concise answers.
`,
    );
    memory.contextForJob(jobId);
    const profile = memory.executeTool("memory_read", { path: "core/profile.md" }, jobId) as { content: string };
    const preferences = memory.executeTool("memory_read", { path: "core/preferences.md" }, jobId) as { content: string };
    expect(profile.content).not.toContain("Deploy the gateway.");
    expect(preferences.content).not.toContain("I prefer concise answers.");
    const archived = fs.readdirSync(path.join(dir, "memory", "archive", String(new Date().getUTCFullYear()), "legacy-memory"));
    expect(archived).toHaveLength(2);
  });

  it("keeps legacy conversation documents out of semantic retrieval while history remains available", () => {
    const { db, memory, dir } = fixture();
    const jobId = enqueueUserJob(db, "Discuss the gateway migration.");
    memory.contextForJob(jobId);
    const legacyPath = path.join(dir, "memory", "topics", "gateway.md");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      `---
kind: state
scope: project:gateway
status: active
created: 2026-07-17T12:00:00.000Z
updated: 2026-07-17T12:00:00.000Z
keywords: [gateway]
sources: [user_message:1]
links: []
---
# Gateway migration

Conversation task state must not become semantic user memory.
`,
    );
    const search = memory.executeTool("memory_search", { query: "gateway migration" }, jobId) as {
      results: Array<{ path: string }>;
    };
    expect(search.results).toEqual([]);
    expect(() => memory.executeTool("memory_read", { path: "topics/gateway.md" }, jobId)).toThrow(
      "Only core/profile.md and core/preferences.md",
    );

    const historyJob = enqueueUserJob(db, "Remember this exact gateway detail.");
    db.completeJob(historyJob, "Gateway answer", "codex", "thread");
    const history = memory.executeTool("history_search", { query: "exact gateway" }, jobId) as {
      results: Array<{ id: number; role: string }>;
    };
    expect(history.results[0]).toMatchObject({ role: "user" });
    const entries = memory.executeTool("history_read", { ids: [history.results[0]!.id] }, jobId) as {
      entries: Array<{ content: string }>;
    };
    expect(entries.entries[0]?.content).toContain("gateway");
  });

  it("accepts handoff references only for profile or preferences changed by that job", () => {
    const { db, memory } = fixture();
    const jobId = enqueueUserJob(db, "I prefer direct answers.");
    const source = userSource(db, jobId);
    const initial = memory.executeTool("memory_read", { path: "core/preferences.md" }, jobId) as { revision: string };
    memory.executeTool(
      "memory_edit",
      {
        path: "core/preferences.md",
        document: userDocument("core/preferences.md", [source], ["I prefer direct answers."]),
        evidence: "I prefer direct answers.",
        expected_revision: initial.revision,
      },
      jobId,
    );
    const laterJob = enqueueUserJob(db, "What did we discuss?");
    memory.contextForJob(laterJob);
    memory.executeTool("memory_read", { path: "core/preferences.md" }, laterJob);
    expect(memory.verifyHandoffReferences(jobId, ["core/preferences.md"])).toBe(true);
    expect(memory.verifyHandoffReferences(laterJob, ["core/preferences.md"])).toBe(false);
  });

  it("offers gateway models only user-memory and history operations", () => {
    expect(memoryToolDefinitions().map((tool) => tool.function.name)).toEqual([
      "memory_search",
      "memory_read",
      "memory_edit",
      "history_search",
      "history_read",
    ]);
  });
});
