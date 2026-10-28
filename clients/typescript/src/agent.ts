import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpGateway } from "./agent-mcp.js";
import {
  isTrustedToolName,
  SHIPMENT_STATUSES,
  TRUSTED_MODEL_TOOLS,
  validateDiscoveredTools,
  type ShipmentStatus,
  type TrustedToolName,
} from "./contracts.js";
import type { ModelAttemptDiagnostic, ModelReliability, ModelRouter, ModelSelection, ModelUsage } from "./model-router.js";
import { AgentDiagnostics, type CompletionKind, type DiagnosticsOptions, type OperationalOutcome } from "./observability.js";
import { openAIErrorCategory, type OpenAIErrorCategory } from "./openai-model-router.js";
import { MAX_TOOL_RESULT_BYTES, readJsonToolResult } from "./response.js";

export const MAX_QUESTION_CHARACTERS = 2_000;
export const NO_TOOL_MESSAGE =
  "I can only list demo shipments, look up a shipment by ID, or filter shipments by Pending, Loading, or Completed status.";

export interface AgentLimits {
  readonly initializationMs: number;
  readonly modelMs: number;
  readonly toolMs: number;
  readonly overallMs: number;
  readonly shutdownMs: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  initializationMs: 10_000,
  modelMs: 20_000,
  toolMs: 15_000,
  overallMs: 45_000,
  shutdownMs: 2_000,
};

export type AgentFailureCode =
  | "invalid_question"
  | "initialization_failed"
  | "initialization_timeout"
  | "model_failed"
  | "model_timeout"
  | "invalid_model_output"
  | "tool_failed"
  | "tool_timeout"
  | "invalid_tool_result"
  | "overall_timeout"
  | "canceled";

export class AgentError extends Error {
  public constructor(public readonly code: AgentFailureCode) {
    super(messageForCode(code));
    this.name = "AgentError";
  }
}

interface ValidatedCall {
  readonly name: TrustedToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface Shipment {
  readonly id: number;
  readonly reference: string;
  readonly status: ShipmentStatus;
  readonly quantity: number;
}

export async function runAgentQuestion(
  question: string,
  router: ModelRouter,
  gateway: McpGateway,
  callerSignal: AbortSignal,
  limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  diagnosticsOptions: DiagnosticsOptions = {},
): Promise<string> {
  const diagnostics = new AgentDiagnostics(diagnosticsOptions);
  const executionStart = diagnostics.monotonicNow();
  diagnostics.executionStarted();

  try {
    validateQuestion(question);
  } catch (error: unknown) {
    diagnostics.executionCompleted(
      outcomeForError(error), "failure", diagnostics.durationSince(executionStart), 0,
      error instanceof AgentError ? error.code : undefined,
    );
    throw error;
  }

  const overall = linkedTimeout(callerSignal, limits.overallMs);
  const execution = { toolCount: 0 as 0 | 1, completionKind: "failure" as CompletionKind };
  let failure: unknown;

  try {
    const result = await raceWithAbort(
      runAgentCore(question, router, gateway, overall.signal, callerSignal, limits, diagnostics, execution),
      overall.signal,
      "overall_timeout",
      callerSignal,
    );
    execution.completionKind = result.completionKind;
    return result.output;
  } catch (error: unknown) {
    failure = error;
    execution.completionKind = "failure";
    throw error;
  } finally {
    overall.dispose();
    await closeWithTimeout(gateway, limits.shutdownMs);
    const activeError = failure instanceof AgentError ? failure : undefined;
    diagnostics.executionCompleted(
      failure === undefined ? "success" : outcomeForError(failure),
      execution.completionKind,
      diagnostics.durationSince(executionStart),
      execution.toolCount,
      activeError?.code,
    );
  }
}

async function runAgentCore(
  question: string,
  router: ModelRouter,
  gateway: McpGateway,
  overallSignal: AbortSignal,
  callerSignal: AbortSignal,
  limits: AgentLimits,
  diagnostics: AgentDiagnostics,
  execution: { toolCount: 0 | 1 },
): Promise<{ readonly output: string; readonly completionKind: CompletionKind }> {
  const initializationStart = diagnostics.monotonicNow();
  try {
    const discovered = await runStage(
      (signal) => gateway.initializeAndDiscover(signal), overallSignal, limits.initializationMs,
      "initialization_timeout", "initialization_failed", callerSignal,
    );
    validateDiscoveredTools(discovered);
    diagnostics.initializationCompleted("success", diagnostics.durationSince(initializationStart));
  } catch (error: unknown) {
    const normalized = error instanceof AgentError ? error : new AgentError("initialization_failed");
    diagnostics.initializationCompleted(outcomeForError(normalized), diagnostics.durationSince(initializationStart));
    throw normalized;
  }

  const modelStart = diagnostics.monotonicNow();
  let usage: ModelUsage = { kind: "unavailable" };
  let reliability: ModelReliability | undefined;
  let errorCategory: OpenAIErrorCategory | undefined;
  let lastAttempt: ModelAttemptDiagnostic | undefined;
  let call: ValidatedCall | undefined;
  try {
    const modelResult = await runStage(
      async (signal) => {
        try {
          return await router.selectTool(question, TRUSTED_MODEL_TOOLS, signal, {
            timeoutMs: limits.modelMs,
            onAttempt: (attempt) => {
              lastAttempt = attempt;
              diagnostics.modelAttemptCompleted(attempt);
            },
          });
        } catch (error: unknown) {
          errorCategory = openAIErrorCategory(error);
          throw error;
        }
      }, overallSignal, limits.modelMs,
      "model_timeout", "model_failed", callerSignal,
    );
    usage = modelResult.usage;
    reliability = modelResult.reliability;
    const selection = modelResult.selection;
    if (selection.kind !== "none") call = validateSelection(selection);
    diagnostics.modelSelectionCompleted("success", diagnostics.durationSince(modelStart), usage, undefined, reliability);
  } catch (error: unknown) {
    diagnostics.modelSelectionCompleted(
      outcomeForError(error), diagnostics.durationSince(modelStart), usage, errorCategory,
      reliability ?? failedReliability(lastAttempt),
    );
    throw error;
  }

  if (call === undefined) {
    const mcpStart = diagnostics.monotonicNow();
    diagnostics.mcpExecutionCompleted("success", diagnostics.durationSince(mcpStart), 0);
    const formattingStart = diagnostics.monotonicNow();
    diagnostics.validationFormattingCompleted("success", diagnostics.durationSince(formattingStart));
    return { output: NO_TOOL_MESSAGE, completionKind: "no_tool" };
  }
  diagnostics.toolSelected(call.name);

  const mcpStart = diagnostics.monotonicNow();
  execution.toolCount = 1;
  let result: CallToolResult;
  try {
    result = await runStage(
      (signal) => gateway.callTool(call.name, call.arguments, signal), overallSignal, limits.toolMs,
      "tool_timeout", "tool_failed", callerSignal,
    );
    diagnostics.mcpExecutionCompleted("success", diagnostics.durationSince(mcpStart), 1, call.name);
  } catch (error: unknown) {
    diagnostics.mcpExecutionCompleted(outcomeForError(error), diagnostics.durationSince(mcpStart), 1, call.name);
    throw error;
  }

  const formattingStart = diagnostics.monotonicNow();
  try {
    const formatted = formatToolResult(call.name, result);
    diagnostics.validationFormattingCompleted("success", diagnostics.durationSince(formattingStart), formatted.resultCount);
    return { output: formatted.output, completionKind: "tool_result" };
  } catch (error: unknown) {
    const normalized = error instanceof AgentError ? error : new AgentError("invalid_tool_result");
    diagnostics.validationFormattingCompleted(outcomeForError(normalized), diagnostics.durationSince(formattingStart));
    throw normalized;
  }
}

function failedReliability(attempt: ModelAttemptDiagnostic | undefined): ModelReliability | undefined {
  if (attempt === undefined) return undefined;
  return {
    attemptCount: attempt.attempt,
    maximumAttempts: attempt.maximumAttempts,
    usageCompleteness: "incomplete",
    postResponseBudgetOutcome: "unknown",
  };
}

function validateQuestion(question: string): void {
  if (question.length === 0 || question.length > MAX_QUESTION_CHARACTERS) throw new AgentError("invalid_question");
}

function validateSelection(selection: Exclude<ModelSelection, { kind: "none" }>): ValidatedCall {
  if (selection.kind !== "tool_calls" || selection.calls.length !== 1) throw new AgentError("invalid_model_output");
  const call = selection.calls[0];
  if (call === undefined || !isTrustedToolName(call.name) || call.arguments.length > 1_024) {
    throw new AgentError("invalid_model_output");
  }

  if (call.name === "list_shipments") {
    if (!/^\s*\{\s*\}\s*$/.test(call.arguments)) throw new AgentError("invalid_model_output");
    return { name: call.name, arguments: {} };
  }
  if (call.name === "get_shipment_by_id") {
    if (!/^\s*\{\s*"shipmentId"\s*:\s*(?:0|[1-9]\d*)\s*\}\s*$/.test(call.arguments)) {
      throw new AgentError("invalid_model_output");
    }
    const parsed = JSON.parse(call.arguments) as { shipmentId: unknown };
    if (!Number.isSafeInteger(parsed.shipmentId) || (parsed.shipmentId as number) < 1 || (parsed.shipmentId as number) > 1_000_000) {
      throw new AgentError("invalid_model_output");
    }
    return { name: call.name, arguments: { shipmentId: parsed.shipmentId } };
  }

  if (!/^\s*\{\s*"status"\s*:\s*"(?:Pending|Loading|Completed)"\s*\}\s*$/.test(call.arguments)) {
    throw new AgentError("invalid_model_output");
  }
  const parsed = JSON.parse(call.arguments) as { status: unknown };
  if (typeof parsed.status !== "string" || !isShipmentStatus(parsed.status)) throw new AgentError("invalid_model_output");
  return { name: call.name, arguments: { status: parsed.status } };
}

function formatToolResult(toolName: TrustedToolName, result: CallToolResult): { output: string; resultCount: number } {
  const value = readJsonToolResult(result, MAX_TOOL_RESULT_BYTES);
  const records = toolName === "get_shipment_by_id" ? [validateShipment(value)] : validateShipmentArray(value);
  if (records.length === 0) return { output: "No shipments found.", resultCount: 0 };
  const lines = ["ID\tReference\tStatus\tQuantity"];
  for (const shipment of records) {
    lines.push(`${shipment.id}\t${shipment.reference}\t${shipment.status}\t${shipment.quantity.toFixed(2)}`);
  }
  return { output: lines.join("\n"), resultCount: records.length };
}

function validateShipmentArray(value: unknown): readonly Shipment[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Invalid shipment array.");
  return value.map(validateShipment);
}

function validateShipment(value: unknown): Shipment {
  if (!isRecord(value)) throw new Error("Invalid shipment.");
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.join(",") !== "id,quantity,reference,status") throw new Error("Invalid shipment fields.");
  const { id, reference, status, quantity } = value;
  if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > 1_000_000) throw new Error("Invalid ID.");
  if (!isSafeText(reference, 50) || reference.trim() !== reference) throw new Error("Invalid reference.");
  if (typeof status !== "string" || !isShipmentStatus(status)) throw new Error("Invalid status.");
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0 || quantity > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error("Invalid quantity.");
  }
  if (Math.abs(quantity * 100 - Math.round(quantity * 100)) > 1e-7) throw new Error("Invalid quantity precision.");
  return { id: id as number, reference, status, quantity };
}

function isShipmentStatus(value: string): value is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runStage<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: AgentFailureCode,
  failureCode: AgentFailureCode,
  callerSignal: AbortSignal,
): Promise<T> {
  const deadline = linkedTimeout(parentSignal, timeoutMs);
  try {
    return await raceWithAbort(operation(deadline.signal), deadline.signal, timeoutCode, callerSignal);
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(callerSignal.aborted ? "canceled" : parentSignal.aborted ? "overall_timeout" : failureCode);
  } finally {
    deadline.dispose();
  }
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutCode: AgentFailureCode,
  callerSignal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    operation.catch(() => undefined);
    return Promise.reject(new AgentError(callerSignal.aborted ? "canceled" : timeoutCode));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new AgentError(callerSignal.aborted ? "canceled" : timeoutCode));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

function linkedTimeout(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  if (parent.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

async function closeWithTimeout(gateway: McpGateway, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      gateway.close().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function outcomeForError(error: unknown): OperationalOutcome {
  if (!(error instanceof AgentError)) return "external_failure";
  switch (error.code) {
    case "invalid_question":
    case "invalid_model_output":
    case "invalid_tool_result":
      return "validation_rejection";
    case "initialization_timeout":
    case "model_timeout":
    case "tool_timeout":
    case "overall_timeout":
      return "timeout";
    case "canceled":
      return "cancellation";
    case "initialization_failed":
    case "model_failed":
    case "tool_failed":
      return "external_failure";
  }
}

function messageForCode(code: AgentFailureCode): string {
  switch (code) {
    case "invalid_question": return "The question must contain between 1 and 2,000 characters.";
    case "initialization_timeout": return "The MCP server did not initialize within 10 seconds.";
    case "model_timeout": return "The model did not respond within 20 seconds.";
    case "tool_timeout": return "The MCP tool did not complete within 15 seconds.";
    case "overall_timeout": return "The request did not complete within 45 seconds.";
    case "canceled": return "The request was canceled.";
    case "invalid_model_output": return "The model returned an invalid tool selection.";
    case "invalid_tool_result": return "The MCP server returned an invalid shipment result.";
    case "initialization_failed": return "The trusted MCP shipment tools were not available.";
    case "model_failed": return "The model request failed.";
    case "tool_failed": return "The MCP tool call failed.";
  }
}
