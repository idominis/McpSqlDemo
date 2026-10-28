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
  readonly reliability?: ModelReliability;
}

export type RetryDecision = "not_needed" | "retry" | "not_retryable" | "attempt_limit" | "canceled" | "deadline_exhausted";

export interface ModelAttemptDiagnostic {
  readonly attempt: number;
  readonly maximumAttempts: 1 | 2;
  readonly outcome: "success" | "failure";
  readonly retryDecision: RetryDecision;
  readonly failureCategory?: string;
  readonly backoffMs?: number;
}

export interface ModelReliability {
  readonly attemptCount: number;
  readonly maximumAttempts: 1 | 2;
  readonly usageCompleteness: "complete" | "incomplete";
  readonly postResponseBudgetOutcome: "within_limit" | "exceeded" | "unknown";
}

export interface ModelRequestOptions {
  /** Maximum time available to this request/attempt. The caller retains the outer deadline. */
  readonly timeoutMs: number;
  /** Absolute monotonic deadline used to close the final pre-dispatch race. */
  readonly deadlineMs?: number;
  /** Clock paired with deadlineMs. Intended for monotonic clocks and deterministic tests. */
  readonly monotonicNow?: () => number;
  /** Minimum whole milliseconds required at the provider's final pre-dispatch boundary. */
  readonly minimumDispatchBudgetMs?: number;
  readonly onAttempt?: (diagnostic: ModelAttemptDiagnostic) => void;
}

/** Provider-neutral seam for a future local/Ollama intent router. */
export interface ModelRouter {
  selectTool(
    question: string,
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
    options?: ModelRequestOptions,
  ): Promise<ModelRouterResult>;
}
