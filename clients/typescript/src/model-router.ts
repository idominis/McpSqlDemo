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

/** Provider-neutral seam for a future local/Ollama intent router. */
export interface ModelRouter {
  selectTool(
    question: string,
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelSelection>;
}
