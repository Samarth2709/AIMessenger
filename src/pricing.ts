import type { TokenUsage } from "./types.js";

interface CodexCreditRate {
  input: number;
  cachedInput: number;
  output: number;
}

// Credits per million tokens from the Codex rate card. Unknown models are intentionally unpriced.
const CODEX_CREDIT_RATES: Record<string, CodexCreditRate> = {
  "gpt-5.6-sol": { input: 125, cachedInput: 12.5, output: 750 },
  "gpt-5.6-terra": { input: 62.5, cachedInput: 6.25, output: 375 },
  "gpt-5.6-luna": { input: 25, cachedInput: 2.5, output: 150 },
  "gpt-5.5": { input: 125, cachedInput: 12.5, output: 750 },
  "gpt-5.5-cyber": { input: 500, cachedInput: 50, output: 3000 },
  "gpt-5.4": { input: 62.5, cachedInput: 6.25, output: 375 },
  "gpt-5.4-mini": { input: 18.75, cachedInput: 1.875, output: 113 },
  "gpt-5.3-codex": { input: 43.75, cachedInput: 4.375, output: 350 },
  "gpt-5.2": { input: 43.75, cachedInput: 4.375, output: 350 },
};

function canonicalModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized === "gpt-5.6" ? "gpt-5.6-sol" : normalized;
}

export function codexCreditsForUsage(
  model: string | undefined,
  usage: TokenUsage | undefined,
): number | undefined {
  if (!model || !usage) return undefined;
  const rate = CODEX_CREDIT_RATES[canonicalModel(model)];
  if (!rate) return undefined;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    uncachedInputTokens * rate.input +
    usage.cachedInputTokens * rate.cachedInput +
    usage.outputTokens * rate.output
  ) / 1_000_000;
}
