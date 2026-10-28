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

/** Fixed, sanitized failure categories shared by every model provider adapter. */
export type ModelFailureCategory =
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_5xx"
  | "network_failure"
  | "request_timeout"
  | "unknown";

interface ModelFailureDetails {
  readonly category: ModelFailureCategory;
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

const modelFailures = new WeakMap<Error, ModelFailureDetails>();

/** Creates a sanitized provider failure carrying trusted, provider-neutral metadata. */
export function createModelFailure(
  category: ModelFailureCategory,
  retryable: boolean,
  message = "The model request failed.",
  httpStatus?: number,
): Error {
  if (!isModelFailureCategory(category)
    || typeof retryable !== "boolean"
    || (httpStatus !== undefined && !isHttpStatus(httpStatus))) {
    throw new Error("Invalid model failure metadata.");
  }
  const failure = new Error(message);
  failure.name = "ModelFailure";
  modelFailures.set(failure, Object.freeze({
    category,
    retryable: retryable && isRetryEligibleHttpFailure(category, httpStatus),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  }));
  return failure;
}

export function modelFailureCategory(error: unknown): ModelFailureCategory | undefined {
  return error instanceof Error ? modelFailures.get(error)?.category : undefined;
}

export function isRetryableModelFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = modelFailures.get(error);
  return details?.retryable === true && isRetryEligibleHttpFailure(details.category, details.httpStatus);
}

/** The single provider-neutral allowlist for retryable, validated HTTP failures. */
function isRetryEligibleHttpFailure(category: ModelFailureCategory, httpStatus: number | undefined): boolean {
  return (category === "http_429" && httpStatus === 429)
    || (category === "http_5xx"
      && (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504));
}

function isHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

export function isModelFailureCategory(value: unknown): value is ModelFailureCategory {
  return value === "http_400"
    || value === "http_401"
    || value === "http_403"
    || value === "http_404"
    || value === "http_429"
    || value === "http_5xx"
    || value === "network_failure"
    || value === "request_timeout"
    || value === "unknown";
}

export type RetryDecision = "not_needed" | "retry" | "not_retryable" | "attempt_limit" | "canceled" | "deadline_exhausted";

export interface ModelAttemptDiagnostic {
  readonly attempt: number;
  readonly maximumAttempts: 1 | 2;
  readonly outcome: "success" | "failure";
  readonly retryDecision: RetryDecision;
  readonly failureCategory?: ModelFailureCategory;
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
