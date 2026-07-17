import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db.js";
import { MemoryService } from "../src/memory.js";

const tempDirs: string[] = [];

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

function document(title: string, status = "active"): string {
  return `---
kind: state
scope: project:aimessenger
status: ${status}
created: 2026-07-17T12:00:00.000Z
updated: 2026-07-17T12:00:00.000Z
keywords: [memory, gateway]
sources: [transcript:1]
links: []
---
# ${title}

The gateway retrieves durable Markdown memory on demand.
`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Markdown memory vault", () => {
  it("initializes a bounded map and creates searchable, audited Markdown documents", () => {
    const { memory } = fixture();
    const context = memory.contextForJob(41);
    expect(context.map).toContain("# Memory index");
    expect(context.map).not.toContain("conversation_context");
    expect(context.cliCommand).toContain("memory-cli.js");

    const created = memory.executeTool(
      "memory_create",
      { path: "projects/aimessenger/state.md", document: document("AIMessenger memory state") },
      41,
    ) as { revision: string };
    const searched = memory.executeTool("memory_search", { query: "gateway memory" }, 41) as {
      results: Array<{ path: string; status: string }>;
    };
    expect(searched.results).toEqual([
      expect.objectContaining({ path: "projects/aimessenger/state.md", status: "active" }),
    ]);
    const read = memory.executeTool("memory_read", { path: "projects/aimessenger/state.md" }, 41) as {
      revision: string;
    };
    expect(read.revision).toBe(created.revision);
    expect(memory.verifyHandoffReferences(41, ["projects/aimessenger/state.md"])).toBe(true);
  });

  it("rejects path escape, secret-like content, and stale optimistic edits", () => {
    const { memory } = fixture();
    memory.contextForJob(42);
    expect(() =>
      memory.executeTool("memory_create", { path: "../escape.md", document: document("Escape") }, 42),
    ).toThrow("permitted Markdown hierarchy");
    expect(() =>
      memory.executeTool(
        "memory_create",
        { path: "topics/secret.md", document: document("Secret").replace("Markdown memory", "sk-abcdefghijklmnopqrstuvwxyz123456") },
        42,
      ),
    ).toThrow("likely secret");
    memory.executeTool("memory_create", { path: "topics/current.md", document: document("Current") }, 42);
    expect(() =>
      memory.executeTool(
        "memory_edit",
        { path: "topics/current.md", document: document("Changed"), expected_revision: "stale" },
        42,
      ),
    ).toThrow("changed");
  });

  it("accepts a safe memory-directory alias while preserving canonical paths and escape checks", () => {
    const { memory } = fixture();
    memory.contextForJob(46);
    const created = memory.executeTool(
      "memory_create",
      { path: "memory/topics/self-improving-ai.md", document: document("Self-improving AI") },
      46,
    ) as { path: string; revision: string };
    expect(created.path).toBe("topics/self-improving-ai.md");
    const read = memory.executeTool(
      "memory_read",
      { path: "./memory/topics/self-improving-ai.md" },
      46,
    ) as { path: string; revision: string };
    expect(read).toMatchObject({ path: created.path, revision: created.revision });
    expect(() =>
      memory.executeTool("memory_create", { path: "memory/../escape.md", document: document("Escape") }, 46),
    ).toThrow("permitted Markdown hierarchy");
  });

  it("supersedes memory and exposes exact history only on demand", () => {
    const { db, memory } = fixture();
    memory.contextForJob(43);
    memory.executeTool("memory_create", { path: "topics/old.md", document: document("Old decision") }, 43);
    memory.executeTool("memory_create", { path: "topics/new.md", document: document("New decision") }, 43);
    const old = memory.executeTool("memory_read", { path: "topics/old.md" }, 43) as { revision: string };
    memory.executeTool(
      "memory_supersede",
      { path: "topics/old.md", replacement_path: "topics/new.md", reason: "Revised design.", expected_revision: old.revision },
      43,
    );
    const defaultSearch = memory.executeTool("memory_search", { query: "old decision" }, 43) as {
      results: Array<{ path: string }>;
    };
    expect(defaultSearch.results.some((result) => result.path === "topics/old.md")).toBe(false);

    db.recordUpdate(100, 200, 300, 400, "remember exact gateway detail");
    const jobId = db.enqueueJob({
      updateId: 100,
      telegramMessageId: 200,
      chatId: 300,
      provider: "codex",
      prompt: "remember exact gateway detail",
      attachments: [],
    });
    db.completeJob(jobId, "gateway answer", "codex", "thread");
    const history = memory.executeTool("history_search", { query: "exact gateway" }, 43) as {
      results: Array<{ id: number }>;
    };
    expect(history.results[0]?.id).toBeDefined();
    const entries = memory.executeTool("history_read", { ids: [history.results[0]!.id] }, 43) as {
      entries: Array<{ content: string }>;
    };
    expect(entries.entries[0]?.content).toContain("gateway");
  });

  it("accepts handoff references only for documents actually changed by that job", () => {
    const { memory } = fixture();
    memory.contextForJob(44);
    memory.executeTool("memory_create", { path: "topics/state.md", document: document("State") }, 44);
    memory.contextForJob(45);
    memory.executeTool("memory_read", { path: "topics/state.md" }, 45);
    expect(memory.verifyHandoffReferences(44, ["topics/state.md"])).toBe(true);
    expect(memory.verifyHandoffReferences(45, ["topics/state.md"])).toBe(false);
  });
});
