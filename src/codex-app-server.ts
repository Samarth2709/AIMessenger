import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexAppServerEvent {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private outputBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: CodexAppServerEvent) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(
    private readonly command: string,
    private readonly workingDirectory: string,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(
      this.command,
      [
        "app-server",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'approval_policy="never"',
        "--stdio",
      ],
      {
        cwd: this.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeOutput(chunk));
    // Drain diagnostics so a noisy child cannot block its own protocol stream.
    child.stderr.resume();
    child.once("error", () => this.handleClose(child));
    child.once("exit", () => this.handleClose(child));

    await this.request("initialize", {
      clientInfo: { name: "aimessenger", title: null, version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
  }

  onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Codex App Server is not running.");
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server did not answer ${method}.`));
      }, 30_000);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(new Error("Codex App Server connection failed."));
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.kill("SIGTERM");
  }

  private consumeOutput(chunk: string): void {
    this.outputBuffer += chunk;
    const lines = this.outputBuffer.split("\n");
    this.outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.handleMessage(message);
      } catch {
        // The protocol is JSONL. Ignore an unexpected diagnostic line.
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        pending.reject(new Error("Codex App Server rejected the request."));
      } else if (message.result && typeof message.result === "object") {
        pending.resolve(message.result as Record<string, unknown>);
      } else {
        pending.reject(new Error("Codex App Server returned an invalid response."));
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "AIMessenger does not implement this App Server request." },
      });
      return;
    }
    if (typeof message.method !== "string" || !message.params || typeof message.params !== "object") {
      return;
    }
    const event = { method: message.method, params: message.params as Record<string, unknown> };
    for (const listener of this.eventListeners) listener(event);
  }

  private write(message: Record<string, unknown>): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleClose(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server stopped."));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
