export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly name: string;
  readonly arguments: string;
}

export type ModelSelection =
  | { readonly kind: "none" }
  | { readonly kind: "tool_calls"; readonly calls: readonly ModelToolCall[] }
  | { readonly kind: "unexpected" };

export type ModelUsage =
  | {
      readonly kind: "available";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | { readonly kind: "unavailable" };

export interface ModelRouterResult {
  readonly selection: ModelSelection;
  readonly usage: ModelUsage;
}

/** Provider-neutral seam for a future local/Ollama intent router. */
export interface ModelRouter {
  selectTool(
    question: string,
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelRouterResult>;
}
