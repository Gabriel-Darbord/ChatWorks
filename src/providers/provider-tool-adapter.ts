import type { ProviderTool } from "./provider-tools.ts";

export type ProviderToolAdapter = {
  present(tool: ProviderTool): ProviderTool;
  restoreInput(
    name: string,
    input: Record<string, unknown>,
  ): Record<string, unknown>;
};

export const identityProviderToolAdapter: ProviderToolAdapter = {
  present: (tool) => tool,
  restoreInput: (_name, input) => input,
};
