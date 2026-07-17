import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer } from "../src/codex-app-server.js";

const tempDirs: string[] = [];

function fakeAppServer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-app-server-"));
  tempDirs.push(dir);
  const command = path.join(dir, "fake-app-server");
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fake" } }) + "\\n");
    }
    if (request.method === "thread/start") {
      process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "thread-1" } } }) + "\\n");
    }
  }
});
`,
    { mode: 0o700 },
  );
  return command;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CodexAppServer", () => {
  it("initializes over JSON-RPC and returns request results", async () => {
    const server = new CodexAppServer(fakeAppServer(), os.tmpdir());
    await server.start();
    const response = await server.request("thread/start", {});

    expect(response).toEqual({ thread: { id: "thread-1" } });
    await server.close();
  });
});
