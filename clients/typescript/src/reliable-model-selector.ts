import type {
  ModelAttemptDiagnostic,
  ModelRequestOptions,
  ModelRouter,
  ModelRouterResult,
  ModelToolDefinition,
  RetryDecision,
} from "./model-router.js";

export const DEFAULT_MODEL_MAX_ATTEMPTS = 1;
export const MODEL_RETRY_BASE_DELAY_MS = 500;
export const MODEL_RETRY_MAX_BACKOFF_MS = 2_000;
export const MINIMUM_RETRY_ATTEMPT_MS = 1_000;

export interface ReliableModelSelectorOptions {
  readonly maximumAttempts?: 1 | 2;
  readonly monotonicNow?: () => number;
  readonly jitter?: () => number;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly failureCategory?: (error: unknown) => string | undefined;
  readonly outputTokenLimit?: number;
}

/** Dependency-free retry boundary. It wraps only model selection; MCP/SQL remain outside it. */
export class ReliableModelSelector implements ModelRouter {
  private readonly maximumAttempts: 1 | 2;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly retryable: (error: unknown) => boolean;
  private readonly categorize: (error: unknown) => string | undefined;
  private readonly outputTokenLimit: number;

  public constructor(private readonly adapter: ModelRouter, options: ReliableModelSelectorOptions = {}) {
    this.maximumAttempts = options.maximumAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS;
    if (this.maximumAttempts !== 1 && this.maximumAttempts !== 2) throw new Error("Model attempts must be 1 or 2.");
    this.now = options.monotonicNow ?? (() => performance.now());
    this.jitter = options.jitter ?? Math.random;
    this.wait = options.delay ?? abortableDelay;
    this.retryable = options.isRetryable ?? (() => false);
    this.categorize = options.failureCategory ?? (() => undefined);
    this.outputTokenLimit = options.outputTokenLimit ?? 256;
  }

  public async selectTool(
    question: string,
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
    options: ModelRequestOptions = { timeoutMs: 20_000 },
  ): Promise<ModelRouterResult> {
    const timeoutMs = validTimeout(options.timeoutMs);
    const deadline = safeNow(this.now) + timeoutMs;
    if (!Number.isFinite(deadline)) throw new Error("Model deadline exhausted.");

    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const attemptBudgetMs = remaining(deadline, this.now);
      throwIfUnavailable(signal, attemptBudgetMs);
      if (attempt > 1 && attemptBudgetMs < MINIMUM_RETRY_ATTEMPT_MS) throw new Error("Model deadline exhausted.");
      try {
        const result = await this.adapter.selectTool(question, tools, signal, {
          timeoutMs: attemptBudgetMs,
          deadlineMs: deadline,
          monotonicNow: this.now,
          ...(attempt > 1 ? { minimumDispatchBudgetMs: MINIMUM_RETRY_ATTEMPT_MS } : {}),
        });
        throwIfUnavailable(signal, remaining(deadline, this.now));
        safelyObserve(options.onAttempt, {
          attempt, maximumAttempts: this.maximumAttempts, outcome: "success", retryDecision: "not_needed",
        });
        return {
          ...result,
          reliability: {
            attemptCount: attempt,
            maximumAttempts: this.maximumAttempts,
            usageCompleteness: attempt === 1 && result.usage.kind === "available" ? "complete" : "incomplete",
            postResponseBudgetOutcome: result.usage.kind === "available"
              ? result.usage.outputTokens <= this.outputTokenLimit ? "within_limit" : "exceeded"
              : "unknown",
          },
        };
      } catch (error: unknown) {
        const category = this.categorize(error);
        const currentRemaining = remaining(deadline, this.now);
        let decision: RetryDecision;
        let backoffMs: number | undefined;
        if (signal.aborted) decision = "canceled";
        else if (currentRemaining <= 0) decision = "deadline_exhausted";
        else if (!this.retryable(error)) decision = "not_retryable";
        else if (attempt >= this.maximumAttempts) decision = "attempt_limit";
        else {
          const candidateBackoffMs = equalJitterBackoff(attempt, this.jitter);
          decision = currentRemaining >= candidateBackoffMs + MINIMUM_RETRY_ATTEMPT_MS ? "retry" : "deadline_exhausted";
          if (decision === "retry") backoffMs = candidateBackoffMs;
        }
        safelyObserve(options.onAttempt, {
          attempt, maximumAttempts: this.maximumAttempts, outcome: "failure", retryDecision: decision,
          ...(category === undefined ? {} : { failureCategory: category }),
          ...(backoffMs === undefined ? {} : { backoffMs }),
        });
        if (decision !== "retry" || backoffMs === undefined) throw error;
        await this.wait(backoffMs, signal);
        const retryBudgetMs = remaining(deadline, this.now);
        throwIfUnavailable(signal, retryBudgetMs);
        if (retryBudgetMs < MINIMUM_RETRY_ATTEMPT_MS) throw new Error("Model deadline exhausted.");
      }
    }
    throw new Error("Unreachable model attempt state.");
  }
}

export function modelMaximumAttempts(environment: NodeJS.ProcessEnv = process.env): 1 | 2 {
  const value = environment.MCP_MODEL_MAX_ATTEMPTS;
  if (value === undefined || value === "1") return 1;
  if (value === "2") return 2;
  throw new Error("MCP_MODEL_MAX_ATTEMPTS must be 1 or 2.");
}

function equalJitterBackoff(attempt: number, source: () => number): number {
  const cap = Math.min(MODEL_RETRY_MAX_BACKOFF_MS, MODEL_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
  const sample = safeJitter(source);
  return Math.floor(cap / 2 + sample * cap / 2);
}

function safeJitter(source: () => number): number {
  try {
    const value = source();
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  } catch {
    return 0;
  }
}

function validTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Model deadline exhausted.");
  return value;
}

function safeNow(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) throw new Error("Model deadline exhausted.");
  return value;
}

function remaining(deadline: number, clock: () => number): number {
  return Math.max(0, Math.floor(deadline - safeNow(clock)));
}

function throwIfUnavailable(signal: AbortSignal, remainingMs: number): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Model request canceled.");
  if (remainingMs <= 0) throw new Error("Model deadline exhausted.");
}

function safelyObserve(observer: ModelRequestOptions["onAttempt"], diagnostic: ModelAttemptDiagnostic): void {
  try { observer?.(diagnostic); } catch { /* Diagnostics never affect control flow. */ }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Model request canceled."));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(complete, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Model request canceled."));
    };
    function complete(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
