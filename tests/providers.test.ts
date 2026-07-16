import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";

const tempDirs: string[] = [];

function executable(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimessenger-provider-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fake-agent");
  fs.writeFileSync(file, `#!/bin/bash\n${contents}\n`, { mode: 0o700 });
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const baseInput = {
  prompt: "hello",
  context: "",
  attachmentPaths: [],
  sessionId: null,
  workingDirectory: os.tmpdir(),
  schemaPath: path.resolve("schemas/agent-result.schema.json"),
  signal: new AbortController().signal,
};

describe("provider adapters", () => {
  it("captures the Codex thread and structured final event", async () => {
    const command = executable(
      `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-123"}' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"message\\":\\"codex ok\\",\\"attachments\\":[]}"}}'`,
    );
    const output = await new CodexProvider(command).run(baseInput);
    expect(output.sessionId).toBe("thread-123");
    expect(output.result).toEqual({ message: "codex ok", attachments: [] });
  });

  it("captures Claude structured_output and session ID", async () => {
    const command = executable(
      `printf '%s\\n' '{"type":"result","session_id":"claude-123","is_error":false,"structured_output":{"message":"claude ok","attachments":[]}}'`,
    );
    const output = await new ClaudeProvider(command).run(baseInput);
    expect(output.sessionId).toBe("claude-123");
    expect(output.result).toEqual({ message: "claude ok", attachments: [] });
  });
});
