import { execFile } from "node:child_process";
import type { ProviderName } from "./types.js";

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  source?: string;
}

export interface ModelCatalog {
  list(provider: ProviderName): Promise<ModelOption[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCodexModels(source: string): ModelOption[] {
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    throw new Error("Codex returned an invalid model catalog.");
  }
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("Codex returned an invalid model catalog.");
  }
  const seen = new Set<string>();
  return payload.models.flatMap((value) => {
    if (!isRecord(value) || value.visibility !== "list" || typeof value.slug !== "string") return [];
    const id = value.slug.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: typeof value.display_name === "string" ? value.display_name : id,
      description: typeof value.description === "string" ? value.description : "",
    }];
  });
}

export function parseGatewayModels(source: string): ModelOption[] {
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    throw new Error("The AI Security gateway returned an invalid model catalog.");
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("The AI Security gateway returned an invalid model catalog.");
  }
  const seen = new Set<string>();
  return payload.data.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string") return [];
    const id = value.id.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: id, description: "AI Security gateway", source: "AI Security" }];
  });
}

export class CliModelCatalog implements ModelCatalog {
  constructor(private readonly codexCommand: string) {}

  async list(provider: ProviderName): Promise<ModelOption[]> {
    if (provider !== "codex") return [];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.codexCommand,
        ["debug", "models"],
        { env: process.env, maxBuffer: 5_000_000, timeout: 30_000 },
        (error, output) => {
          if (error) {
            reject(new Error("Could not load the Codex model catalog."));
            return;
          }
          resolve(output);
        },
      );
    });
    const models = parseCodexModels(stdout);
    if (!models.length) throw new Error("Codex did not expose any selectable models.");
    return models;
  }
}

export class GatewayModelCatalog implements ModelCatalog {
  constructor(
    private readonly apiBase: string,
    private readonly apiKey: string | undefined,
    private readonly allowedModels?: ReadonlySet<string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async list(provider: ProviderName): Promise<ModelOption[]> {
    if (provider !== "codex" || !this.apiKey) return [];
    const response = await this.request(`${this.apiBase.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`The AI Security gateway returned HTTP ${response.status}.`);
    return parseGatewayModels(body).filter(
      (model) => !this.allowedModels || this.allowedModels.has(model.id),
    );
  }
}

export class CombinedModelCatalog implements ModelCatalog {
  constructor(private readonly catalogs: ModelCatalog[]) {}

  async list(provider: ProviderName): Promise<ModelOption[]> {
    const results = await Promise.allSettled(this.catalogs.map((catalog) => catalog.list(provider)));
    const models = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (!models.length) {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    return models;
  }
}
