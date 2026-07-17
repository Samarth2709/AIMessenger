import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLogger } from "../src/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("JsonLogger", () => {
  it("writes private JSONL records and mirrors them to the service journal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-logs-"));
    tempDirs.push(dir);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = new JsonLogger(dir);

    logger.info("job.queued", { job_id: 7, text_length: 12 });

    const logFile = path.join(dir, "aimessenger.jsonl");
    const record = JSON.parse(fs.readFileSync(logFile, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ level: "info", event: "job.queued", job_id: 7, text_length: 12 });
    expect(record.timestamp).toEqual(expect.any(String));
    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(record));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it("does not write error messages that could contain agent output", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-logs-"));
    tempDirs.push(dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = new JsonLogger(dir);

    const error = Object.assign(new Error("private agent reply"), { code: 429 });
    logger.error("job.failed", error);

    const record = fs.readFileSync(path.join(dir, "aimessenger.jsonl"), "utf8");
    expect(record).toContain('"error_name":"Error"');
    expect(record).toContain('"error_code":429');
    expect(record).not.toContain("private agent reply");
  });
});
