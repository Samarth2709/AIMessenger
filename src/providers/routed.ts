import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./types.js";
import { GatewayCapabilityError } from "./gateway.js";

export class ModelRoutedProvider implements AgentProvider {
  constructor(
    private readonly defaultProvider: AgentProvider,
    private readonly gatewayProvider: AgentProvider,
    private readonly gatewayModels: ReadonlySet<string>,
    private readonly fallbackModel?: string,
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    if (!this.gatewayModels.has(input.model ?? "")) return this.defaultProvider.run(input);
    try {
      return await this.gatewayProvider.run(input);
    } catch (error) {
      if (!(error instanceof GatewayCapabilityError)) throw error;
      const fallback = await this.defaultProvider.run({ ...input, model: this.fallbackModel, sessionId: null });
      return {
        ...fallback,
        routing: {
          requestedModel: input.model,
          fallbackReason: error.message,
          ...(this.fallbackModel ? { executedModel: this.fallbackModel } : {}),
        },
      };
    }
  }
}
