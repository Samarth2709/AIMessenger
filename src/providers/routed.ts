import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./types.js";

export class ModelRoutedProvider implements AgentProvider {
  constructor(
    private readonly defaultProvider: AgentProvider,
    private readonly gatewayProvider: AgentProvider,
    private readonly gatewayModels: ReadonlySet<string>,
  ) {}

  run(input: ProviderRunInput): Promise<ProviderRunOutput> {
    return this.gatewayModels.has(input.model ?? "")
      ? this.gatewayProvider.run(input)
      : this.defaultProvider.run(input);
  }
}
