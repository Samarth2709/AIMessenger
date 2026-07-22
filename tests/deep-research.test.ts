import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/db.js";
import { DeepResearchCoordinator } from "../src/deep-research.js";
import type { AppLogger } from "../src/logger.js";
import type { AgentProvider } from "../src/providers/types.js";

const directories: string[] = [];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-research-"));
  directories.push(directory);
  const db = new AppDatabase(path.join(directory, "test.sqlite"));
  db.recordUpdate(1, 2, 3, 4, "Conduct deep research on Bluetooth interference.");
  const jobId = db.enqueueJob({
    updateId: 1,
    telegramMessageId: 2,
    chatId: 3,
    provider: "codex",
    prompt: "Conduct deep research on Bluetooth interference.",
    attachments: [],
    mode: "deep_research",
  });
  const job = db.claimNextJob()!;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies AppLogger;
  return { directory, db, jobId, job, logger };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("DeepResearchCoordinator", () => {
  it("runs five isolated tracks concurrently and synthesizes their results", async () => {
    const { directory, db, job, logger } = fixture();
    let active = 0;
    let peak = 0;
    const provider: AgentProvider = {
      run: vi.fn(async (input) => {
        if (input.prompt.includes("<research_synthesis>")) {
          return { result: { message: "Synthesized answer.", attachments: [] }, sessionId: null, rawOutput: "" };
        }
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          result: { message: `Track result with https://example.test/${active}`, attachments: [] },
          sessionId: null,
          rawOutput: "",
        };
      }),
    };
    const coordinator = new DeepResearchCoordinator(provider, db, logger);

    const output = await coordinator.run({
      job,
      identity: "# Iris",
      skills: [],
      workingDirectory: directory,
      schemaPath: path.resolve("schemas/agent-result.schema.json"),
      signal: new AbortController().signal,
    });

    expect(peak).toBe(5);
    expect(provider.run).toHaveBeenCalledTimes(6);
    expect(output.result.message).toContain("5 independent tracks (5 completed, 0 failed; 5 distinct direct sources)");
    expect(output.result.message).toContain("Sources:\n- [Source 1](https://example.test/");
    expect(output.routing).toBeUndefined();
    const trackInput = vi.mocked(provider.run).mock.calls[0]![0];
    expect(trackInput.memory).toBeUndefined();
    expect(trackInput.attachmentPaths).toEqual([]);
    expect(trackInput.attachmentContext).toBeUndefined();
    expect(trackInput.conversationContext).toBeUndefined();
    expect(trackInput.prompt).toContain("Do not edit files");
    db.close();
  });

  it("expands to ten tracks only for an explicit exhaustive request", async () => {
    const { directory, db, job, logger } = fixture();
    let trackCalls = 0;
    const provider: AgentProvider = {
      run: vi.fn(async (input) => ({
        result: {
          message: input.prompt.includes("<research_synthesis>")
            ? "Synthesized"
            : `Track evidence https://example.test/evidence-${++trackCalls}`,
          attachments: [],
        },
        sessionId: null,
        rawOutput: "",
      })),
    };
    const coordinator = new DeepResearchCoordinator(provider, db, logger);
    await coordinator.run({
      job: { ...job, prompt: "Do exhaustive deep research on Bluetooth interference." },
      identity: "# Iris",
      skills: [],
      workingDirectory: directory,
      schemaPath: path.resolve("schemas/agent-result.schema.json"),
      signal: new AbortController().signal,
    });
    expect(provider.run).toHaveBeenCalledTimes(11);
    db.close();
  });

  it("synthesizes the completed tracks when two of five tracks fail", async () => {
    const { directory, db, job, logger } = fixture();
    let trackCalls = 0;
    const provider: AgentProvider = {
      run: vi.fn(async (input) => {
        if (input.prompt.includes("<research_synthesis>")) {
          return { result: { message: "Synthesized partial evidence.", attachments: [] }, sessionId: null, rawOutput: "" };
        }
        trackCalls += 1;
        if (trackCalls > 3) throw new Error("track unavailable");
        return {
          result: { message: `Evidence ${trackCalls} https://example.test/${trackCalls}`, attachments: [] },
          sessionId: null,
          rawOutput: "",
        };
      }),
    };
    const coordinator = new DeepResearchCoordinator(provider, db, logger);

    const output = await coordinator.run({
      job,
      identity: "# Iris",
      skills: [],
      workingDirectory: directory,
      schemaPath: path.resolve("schemas/agent-result.schema.json"),
      signal: new AbortController().signal,
    });

    expect(output.result.message).toContain("3 completed, 2 failed");
    expect(provider.run).toHaveBeenCalledTimes(6);
    expect(logger.info).toHaveBeenCalledWith(
      "deep_research.completed",
      expect.objectContaining({ completed_tracks: 3, failed_tracks: 2 }),
    );
    db.close();
  });

  it("rejects a result whose cited tracks do not provide two distinct sources", async () => {
    const { directory, db, job, logger } = fixture();
    let trackCalls = 0;
    const provider: AgentProvider = {
      run: vi.fn(async () => {
        trackCalls += 1;
        return {
          result: {
            message:
              trackCalls <= 3
                ? "Cited finding https://example.test/only-source"
                : "Findings without a citation",
            attachments: [],
          },
          sessionId: null,
          rawOutput: "",
        };
      }),
    };
    const coordinator = new DeepResearchCoordinator(provider, db, logger);

    await expect(
      coordinator.run({
        job,
        identity: "# Iris",
        skills: [],
        workingDirectory: directory,
        schemaPath: path.resolve("schemas/agent-result.schema.json"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("only 1 distinct direct source link");

    expect(provider.run).toHaveBeenCalledTimes(5);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("records the selected model as the executed research model", async () => {
    const { directory, db, job, logger } = fixture();
    let trackCalls = 0;
    const provider: AgentProvider = {
      run: vi.fn(async (input) => ({
        result: {
          message: input.prompt.includes("<research_synthesis>")
            ? "Synthesized"
            : `Track evidence https://example.test/evidence-${++trackCalls}`,
          attachments: [],
        },
        sessionId: null,
        rawOutput: "",
      })),
    };
    const coordinator = new DeepResearchCoordinator(provider, db, logger);

    const output = await coordinator.run({
      job,
      identity: "# Iris",
      skills: [],
      workingDirectory: directory,
      schemaPath: path.resolve("schemas/agent-result.schema.json"),
      signal: new AbortController().signal,
      model: "gpt-5.6-terra",
    });

    expect(output.routing).toEqual({ requestedModel: "gpt-5.6-terra", executedModel: "gpt-5.6-terra" });
    db.close();
  });

  it("fails clearly and cleans tracked workers when fewer than three tracks complete", async () => {
    const { directory, db, job, logger } = fixture();
    const controller = new AbortController();
    controller.abort();
    let pid = 10_000;
    const provider: AgentProvider = {
      run: vi.fn(async (input) => {
        input.onProcessStart?.(pid++);
        throw new DOMException("Job canceled.", "AbortError");
      }),
    };
    const coordinator = new DeepResearchCoordinator(provider, db, logger);

    await expect(
      coordinator.run({
        job,
        identity: "# Iris",
        skills: [],
        workingDirectory: directory,
        schemaPath: path.resolve("schemas/agent-result.schema.json"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("at least 3 are required");

    expect(provider.run).toHaveBeenCalledTimes(5);
    expect(db.runningProcessPids()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(5);
    db.close();
  });
});
