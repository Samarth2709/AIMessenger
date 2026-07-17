import fs from "node:fs/promises";
import path from "node:path";
import { chunkText } from "./chunk.js";
import type { Config } from "./config.js";
import { validateOutboundAttachment } from "./media.js";
import type { AgentResult, OutboxInput } from "./types.js";

export async function prepareResultOutbox(
  result: AgentResult,
  chatId: number,
  jobId: number,
  config: Pick<Config, "AIMESSENGER_WORKING_DIR" | "jobsDir">,
): Promise<OutboxInput[]> {
  const outbound: OutboxInput[] = chunkText(result.message).map((text) => ({
    chatId,
    kind: "text",
    payload: { text },
  }));
  const outputDir = path.join(config.jobsDir, String(jobId), "output");
  for (const attachment of result.attachments) {
    try {
      const validated = await validateOutboundAttachment(
        attachment.path,
        config.AIMESSENGER_WORKING_DIR,
      );
      await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
      const durablePath = path.join(outputDir, `${outbound.length + 1}-${path.basename(validated)}`);
      await fs.copyFile(validated, durablePath);
      await fs.chmod(durablePath, 0o600);
      outbound.push({
        chatId,
        kind: "document",
        payload: { path: durablePath, ...(attachment.caption ? { caption: attachment.caption } : {}) },
      });
    } catch (error) {
      outbound.push({
        chatId,
        kind: "text",
        payload: {
          text: `Could not prepare attachment ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }
  return outbound;
}
