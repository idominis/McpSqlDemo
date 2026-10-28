import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentFailureCode } from "./agent.js";
import type { TrustedToolName } from "./contracts.js";
import {
  isModelFailureCategory,
  type ModelAttemptDiagnostic,
  type ModelFailureCategory,
  type ModelReliability,
  type ModelUsage,
} from "./model-router.js";

export type OperationalOutcome =
  | "success"
  | "validation_rejection"
  | "timeout"
  | "cancellation"
  | "external_failure";

export type CompletionKind = "tool_result" | "no_tool" | "failure";

export interface DiagnosticsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly uuid?: () => string;
  readonly clock?: () => number;
  readonly timestamp?: () => Date;
  readonly writer?: (line: string) => void;
  readonly serialize?: (value: unknown) => string | undefined;
}

type JsonEvent = Readonly<Record<string, string | number>>;

/** A fail-closed JSONL event sink. Its methods accept only already validated operational metadata. */
export class AgentDiagnostics {
  public readonly correlationId: string;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly timestampNow: () => Date;
  private readonly writeLine: (line: string) => void;
  private readonly stringify: (value: unknown) => string | undefined;

  public constructor(options: DiagnosticsOptions = {}) {
    this.enabled = (options.environment ?? process.env).MCP_AGENT_DIAGNOSTICS === "1";
    this.correlationId = safeUuid(options.uuid);
    this.now = options.clock ?? (() => performance.now());
    this.timestampNow = options.timestamp ?? (() => new Date());
    this.writeLine = options.writer ?? ((line) => { process.stderr.write(line); });
    this.stringify = options.serialize ?? JSON.stringify;
  }

  public monotonicNow(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  public durationSince(start: number): number {
    return safeDuration(this.monotonicNow() - start);
  }

  public executionStarted(): void {
    this.emit(this.base("agent.execution.started"));
  }

  public initializationCompleted(outcome: OperationalOutcome, durationMs: number): void {
    this.emit({ ...this.base("agent.stage.completed"), stage: "mcp_initialization", outcome, duration_ms: safeDuration(durationMs) });
  }

  public modelSelectionCompleted(
    outcome: OperationalOutcome,
    durationMs: number,
    usage: ModelUsage,
    errorCategory?: ModelFailureCategory,
    reliability?: ModelReliability,
  ): void {
    const event: Record<string, string | number> = {
      ...this.base("agent.stage.completed"), stage: "model_selection", outcome, duration_ms: safeDuration(durationMs),
    };
    if (usage.kind === "available" && validUsage(usage)) {
      event.input_tokens = usage.inputTokens;
      event.output_tokens = usage.outputTokens;
      event.total_tokens = usage.totalTokens;
    }
    if (isModelFailureCategory(errorCategory)) event.error_category = errorCategory;
    if (reliability !== undefined && validReliability(reliability)) {
      event.total_model_attempt_count = reliability.attemptCount;
      event.maximum_model_attempts = reliability.maximumAttempts;
      event.usage_completeness = reliability.usageCompleteness;
      event.post_response_budget_outcome = reliability.postResponseBudgetOutcome;
    }
    this.emit(event);
  }

  public modelAttemptCompleted(diagnostic: ModelAttemptDiagnostic): void {
    if (!validAttemptDiagnostic(diagnostic)) return;
    this.emit({
      ...this.base("agent.model.attempt.completed"),
      model_attempt: diagnostic.attempt,
      maximum_model_attempts: diagnostic.maximumAttempts,
      outcome: diagnostic.outcome,
      retry_decision: diagnostic.retryDecision,
      ...(isModelFailureCategory(diagnostic.failureCategory) ? { error_category: diagnostic.failureCategory } : {}),
      ...(validBackoff(diagnostic.backoffMs) ? { backoff_ms: diagnostic.backoffMs } : {}),
    });
  }

  public toolSelected(toolName: TrustedToolName): void {
    this.emit({ ...this.base("agent.tool.selected"), tool_name: toolName });
  }

  public mcpExecutionCompleted(
    outcome: OperationalOutcome,
    durationMs: number,
    executionCount: 0 | 1,
    toolName?: TrustedToolName,
  ): void {
    this.emit({
      ...this.base("agent.stage.completed"),
      stage: "mcp_execution",
      outcome,
      duration_ms: safeDuration(durationMs),
      execution_count: executionCount,
      ...(toolName === undefined ? {} : { tool_name: toolName }),
    });
  }

  public validationFormattingCompleted(
    outcome: OperationalOutcome,
    durationMs: number,
    resultCount?: number,
  ): void {
    this.emit({
      ...this.base("agent.stage.completed"),
      stage: "validation_formatting",
      outcome,
      duration_ms: safeDuration(durationMs),
      ...(isResultCount(resultCount) ? { result_count: resultCount } : {}),
    });
  }

  public executionCompleted(
    outcome: OperationalOutcome,
    completionKind: CompletionKind,
    durationMs: number,
    toolExecutionCount: 0 | 1,
    failureCode?: AgentFailureCode,
  ): void {
    this.emit({
      ...this.base("agent.execution.completed"),
      outcome,
      completion_kind: completionKind,
      duration_ms: safeDuration(durationMs),
      tool_execution_count: toolExecutionCount,
      ...(failureCode === undefined ? {} : { failure_code: failureCode }),
    });
  }

  private base(event: string): Record<string, string | number> {
    return {
      schema_version: 1,
      timestamp: safeTimestamp(this.timestampNow),
      event,
      correlation_id: this.correlationId,
    };
  }

  private emit(event: JsonEvent): void {
    if (!this.enabled) return;
    try {
      const json = this.stringify(event);
      if (typeof json === "string") this.writeLine(`${json}\n`);
    } catch {
      // Diagnostics are deliberately best-effort and may never alter agent behavior.
    }
  }
}

function safeUuid(factory: (() => string) | undefined): string {
  try {
    const value = (factory ?? randomUUID)();
    if (typeof value === "string" && isUuid(value)) return value;
  } catch {
    // Fall back to the platform generator without surfacing an observability failure.
  }
  try {
    return randomUUID();
  } catch {
    return "00000000-0000-4000-8000-000000000000";
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeTimestamp(factory: () => Date): string {
  try {
    const value = factory().toISOString();
    return value;
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function safeDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isResultCount(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 20;
}

function validUsage(usage: Extract<ModelUsage, { kind: "available" }>): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

function validReliability(value: ModelReliability): boolean {
  return Number.isInteger(value.attemptCount) && value.attemptCount >= 1 && value.attemptCount <= 2
    && (value.maximumAttempts === 1 || value.maximumAttempts === 2)
    && value.attemptCount <= value.maximumAttempts
    && (value.usageCompleteness === "complete" || value.usageCompleteness === "incomplete")
    && (value.postResponseBudgetOutcome === "within_limit" || value.postResponseBudgetOutcome === "exceeded" || value.postResponseBudgetOutcome === "unknown");
}

function validAttemptDiagnostic(value: ModelAttemptDiagnostic): boolean {
  return Number.isInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 2
    && (value.maximumAttempts === 1 || value.maximumAttempts === 2)
    && value.attempt <= value.maximumAttempts
    && (value.outcome === "success" || value.outcome === "failure")
    && ["not_needed", "retry", "not_retryable", "attempt_limit", "canceled", "deadline_exhausted"].includes(value.retryDecision);
}

function validBackoff(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 2_000;
}
