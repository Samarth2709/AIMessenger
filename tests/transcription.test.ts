import { describe, expect, it, vi } from "vitest";
import { TranscriptionService } from "../src/transcription.js";
import type { RemoteAttachment } from "../src/types.js";

const attachment: RemoteAttachment = {
  fileId: "voice-1",
  fileName: "input.ogg",
  mimeType: "audio/ogg",
  fileSize: 1_000,
};

describe("TranscriptionService", () => {
  it("adds a timestamped local transcript for audio without failing the attachment job", async () => {
    const runner = {
      run: vi.fn(async () => ({
        language: "en",
        durationSeconds: 4,
        text: "Hello from Iris.",
        segments: [{ startSeconds: 4, text: "Hello from Iris." }],
      })),
    };
    const service = new TranscriptionService({ enabled: true, maxSeconds: 900 }, runner);

    const result = await service.transcribe([attachment], ["/tmp/input.ogg"], new AbortController().signal);

    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ inputPath: "/tmp/input.ogg" }));
    expect(result.context).toContain("Hello from Iris.");
    expect(result.context).toContain("00:04");
  });

  it("leaves unsupported media and failed transcription as non-fatal metadata-only input", async () => {
    const runner = { run: vi.fn(async () => { throw new Error("runtime unavailable"); }) };
    const service = new TranscriptionService({ enabled: true, maxSeconds: 900 }, runner);
    const result = await service.transcribe(
      [{ ...attachment, mimeType: "application/pdf", fileName: "input.pdf" }, attachment],
      ["/tmp/input.pdf", "/tmp/input.ogg"],
      new AbortController().signal,
    );

    expect(result.context).toBeUndefined();
    expect(result.failed).toBe(1);
  });

  it("passes the 15-minute cap to the local runner and keeps an over-limit file non-fatal", async () => {
    const runner = { run: vi.fn(async () => { throw new Error("Media is 901s, exceeding the 900s transcription limit."); }) };
    const service = new TranscriptionService({ enabled: true, maxSeconds: 900 }, runner);

    const result = await service.transcribe([attachment], ["/tmp/input.ogg"], new AbortController().signal);

    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({ maxSeconds: 900 }));
    expect(result).toEqual({ transcribed: 0, failed: 1 });
  });
});
