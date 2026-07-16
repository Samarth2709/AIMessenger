import { spawn } from "node:child_process";

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onStdoutChunk?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > 10_000_000 ? next.slice(-10_000_000) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      onStdoutChunk?.(text);
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));

    const kill = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    };

    const abort = (): void => kill();
    if (signal.aborted) kill();
    signal.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(new DOMException("Agent process was canceled.", "AbortError"));
      } else if (code !== 0) {
        reject(
          new ProcessError(
            `${command} exited with status ${code}.`,
            stdout,
            stderr,
            code,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
