import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APIError, APIUserAbortError } from "openai";
import { AgentError, NO_TOOL_MESSAGE, runAgentQuestion, type AgentLimits } from "../src/agent.js";
import type { McpGateway } from "../src/agent-mcp.js";
import type { DiscoveredTool, TrustedToolName } from "../src/contracts.js";
import { createModelFailure, type ModelRouter, type ModelRouterResult, type ModelSelection, type ModelUsage } from "../src/model-router.js";
import type { DiagnosticsOptions } from "../src/observability.js";
import { DEFAULT_OPENAI_MODEL, OpenAIModelRouter } from "../src/openai-model-router.js";
import { ReliableModelSelector } from "../src/reliable-model-selector.js";

const correlationId = "11111111-2222-4333-8444-555555555555";
const fixedTimestamp = new Date("2026-10-28T12:00:00.000Z");
const validTools: readonly DiscoveredTool[] = [
  { name: "list_shipments", inputSchema: { type: "object", properties: {} } },
  { name: "get_shipment_by_id", inputSchema: { type: "object", properties: { shipmentId: { type: "integer" } }, required: ["shipmentId"] } },
  { name: "get_shipments_by_status", inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] } },
];

describe("secure agent diagnostics", () => {
  it("generates one UUID per execution and keeps it consistent across every event", async () => {
    const lines: Array<Record<string, unknown>> = [];
    await runAgentQuestion(
      "hello", fixedRouter({ kind: "none" }), new FakeGateway(jsonResult([])), new AbortController().signal,
      undefined,
      {
        environment: { MCP_AGENT_DIAGNOSTICS: "1" },
        writer: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      },
    );
    const ids = new Set(lines.map((event) => event.correlation_id));
    assert.equal(ids.size, 1);
    assert.match(String([...ids][0]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("emits correlated, ordered, allowlisted success events with exact monotonic durations", async () => {
    const secretQuestion = "list shipments SECRET-QUESTION";
    const secretReference = "SECRET-SQL-ROW";
    const { options, events, uuidCalls } = captureDiagnostics([0, 10, 15, 20, 27, 30, 41, 50, 53, 60]);
    (options.environment as NodeJS.ProcessEnv).OPENAI_API_KEY = "SECRET-API-CREDENTIAL";
    (options.environment as NodeJS.ProcessEnv).MCP_SQL_CONNECTION = "Server=SECRET-DATABASE;Password=SECRET-PASSWORD";
    const gateway = new FakeGateway(jsonResult([
      { id: 7, reference: secretReference, status: "Pending", quantity: 1 },
    ]));

    const output = await runAgentQuestion(
      secretQuestion, fixedRouter(call("list_shipments", "{}"), availableUsage(4, 2, 6)),
      gateway, new AbortController().signal, undefined, options,
    );

    assert.match(output, /SECRET-SQL-ROW/);
    assert.equal(uuidCalls(), 1);
    assert.deepEqual(events.map((event) => event.event), [
      "agent.execution.started",
      "agent.stage.completed",
      "agent.stage.completed",
      "agent.tool.selected",
      "agent.stage.completed",
      "agent.stage.completed",
      "agent.execution.completed",
    ]);
    assert.deepEqual(events.filter(isStage).map((event) => [event.stage, event.duration_ms]), [
      ["mcp_initialization", 5],
      ["model_selection", 7],
      ["mcp_execution", 11],
      ["validation_formatting", 3],
    ]);
    assert.deepEqual(events[2], {
      ...common("agent.stage.completed"), stage: "model_selection", outcome: "success", duration_ms: 7,
      input_tokens: 4, output_tokens: 2, total_tokens: 6,
    });
    assert.deepEqual(events[3], { ...common("agent.tool.selected"), tool_name: "list_shipments" });
    assert.deepEqual(events[4], {
      ...common("agent.stage.completed"), stage: "mcp_execution", outcome: "success", duration_ms: 11,
      execution_count: 1, tool_name: "list_shipments",
    });
    assert.deepEqual(events[5], {
      ...common("agent.stage.completed"), stage: "validation_formatting", outcome: "success", duration_ms: 3,
      result_count: 1,
    });
    assert.deepEqual(events[6], {
      ...common("agent.execution.completed"), outcome: "success", completion_kind: "tool_result",
      duration_ms: 60, tool_execution_count: 1,
    });
    assertNoSentinels(events, [
      secretQuestion, secretReference, "{}", "Pending", "SECRET-API-CREDENTIAL", "SECRET-DATABASE", "SECRET-PASSWORD",
    ]);
  });

  it("emits deterministic no-tool stages without selecting or executing a tool", async () => {
    const { options, events } = captureDiagnostics([0, 1, 3, 4, 8, 9, 9, 10, 12, 15]);
    const output = await runAgentQuestion(
      "hello", fixedRouter({ kind: "none" }), new FakeGateway(jsonResult([])),
      new AbortController().signal, undefined, options,
    );

    assert.equal(output, NO_TOOL_MESSAGE);
    assert.deepEqual(events.map((event) => event.event), [
      "agent.execution.started", "agent.stage.completed", "agent.stage.completed",
      "agent.stage.completed", "agent.stage.completed", "agent.execution.completed",
    ]);
    assert.equal(events.some((event) => event.event === "agent.tool.selected"), false);
    assert.equal(events[3]?.execution_count, 0);
    assert.equal(events[5]?.completion_kind, "no_tool");
    assert.equal(events[5]?.tool_execution_count, 0);
  });

  it("classifies rejected model output without logging the untrusted tool or arguments", async () => {
    const maliciousTool = "exfiltrate_SECRET_ARGUMENT";
    const { options, events } = captureDiagnostics([0, 1, 2, 3, 6, 8]);
    await assert.rejects(
      runAgentQuestion(
        "SECRET PROMPT", fixedRouter(call(maliciousTool, '{"password":"SECRET-CREDENTIAL"}')),
        new FakeGateway(jsonResult([])), new AbortController().signal, undefined, options,
      ),
      (error: unknown) => error instanceof AgentError && error.code === "invalid_model_output",
    );

    assert.deepEqual(events.map((event) => event.event), [
      "agent.execution.started", "agent.stage.completed", "agent.stage.completed", "agent.execution.completed",
    ]);
    assert.equal(events[2]?.outcome, "validation_rejection");
    assert.equal(events[3]?.failure_code, "invalid_model_output");
    assertNoSentinels(events, [maliciousTool, "SECRET", "password"]);
  });

  it("omits result count when complete MCP result validation rejects sensitive data", async () => {
    const secretPayload = "SECRET-INVALID-MCP-RESULT";
    const { options, events } = captureDiagnostics();
    await assert.rejects(
      runAgentQuestion(
        "list", fixedRouter(call("list_shipments", "{}")),
        new FakeGateway(jsonResult([{ id: 1, reference: secretPayload, status: "SECRET-STATUS", quantity: 1 }])),
        new AbortController().signal, undefined, options,
      ),
      (error: unknown) => error instanceof AgentError && error.code === "invalid_tool_result",
    );
    const validation = events.find((event) => event.stage === "validation_formatting");
    assert.equal(validation?.outcome, "validation_rejection");
    assert.equal("result_count" in (validation ?? {}), false);
    assertNoSentinels(events, [secretPayload, "SECRET-STATUS"]);
  });

  it("classifies timeout, cancellation, and external failure using sanitized fixed values", async () => {
    const limits: AgentLimits = { initializationMs: 20, modelMs: 5, toolMs: 20, overallMs: 50, shutdownMs: 1 };
    const timeout = captureDiagnostics();
    const neverRouter: ModelRouter = { selectTool: () => new Promise(() => undefined) };
    await assert.rejects(
      runAgentQuestion("list", neverRouter, new FakeGateway(jsonResult([])), new AbortController().signal, limits, timeout.options),
      (error: unknown) => error instanceof AgentError && error.code === "model_timeout",
    );
    assert.equal(timeout.events.at(-1)?.outcome, "timeout");
    assert.equal(timeout.events.at(-1)?.failure_code, "model_timeout");

    const canceled = captureDiagnostics();
    const controller = new AbortController();
    controller.abort("SECRET-CANCEL-REASON");
    await assert.rejects(
      runAgentQuestion("list", fixedRouter({ kind: "none" }), new FakeGateway(jsonResult([])), controller.signal, limits, canceled.options),
      (error: unknown) => error instanceof AgentError && error.code === "canceled",
    );
    assert.equal(canceled.events.at(-1)?.outcome, "cancellation");

    const external = captureDiagnostics();
    const rawFailure = "RAW-EXCEPTION Server=private;Password=SECRET C:\\sensitive\\file";
    const failingRouter: ModelRouter = { async selectTool() { throw new Error(rawFailure); } };
    await assert.rejects(
      runAgentQuestion("list", failingRouter, new FakeGateway(jsonResult([])), new AbortController().signal, limits, external.options),
      (error: unknown) => error instanceof AgentError && error.code === "model_failed",
    );
    assert.equal(external.events.at(-1)?.outcome, "external_failure");
    assert.equal("error_category" in (external.events.find((event) => event.stage === "model_selection") ?? {}), false);
    assertNoSentinels(external.events, [rawFailure, "Password", "private", "sensitive"]);
  });

  it("preserves agent timeout handling when the SDK reports signal cancellation", async () => {
    const router = new OpenAIModelRouter({
      create(_body, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
        });
      },
    }, DEFAULT_OPENAI_MODEL);
    const limits: AgentLimits = { initializationMs: 20, modelMs: 5, toolMs: 20, overallMs: 50, shutdownMs: 1 };
    const captured = captureDiagnostics();

    await assert.rejects(
      runAgentQuestion("list", router, new FakeGateway(jsonResult([])), new AbortController().signal, limits, captured.options),
      (error: unknown) => error instanceof AgentError
        && error.code === "model_timeout"
        && error.message === "The model did not respond within 20 seconds.",
    );
    const modelEvent = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(modelEvent?.outcome, "timeout");
    assert.equal("error_category" in (modelEvent ?? {}), false);
  });

  it("adds only the allowlisted OpenAI category without exposing raw request failure data", async () => {
    const secretQuestion = "SECRET MODEL PROMPT";
    const secretMessage = "SECRET SDK MESSAGE";
    const secretBody = { message: "SECRET RESPONSE BODY" };
    const secretHeaders = new Headers({ Authorization: "Bearer SECRET-AUTHORIZATION", "x-private": "SECRET-HEADER" });
    const sdkError = new APIError(401, secretBody, secretMessage, secretHeaders);
    const router = new OpenAIModelRouter({ async create() { throw sdkError; } }, DEFAULT_OPENAI_MODEL);
    const captured = captureDiagnostics();

    await assert.rejects(
      runAgentQuestion(
        secretQuestion, router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options,
      ),
      (error: unknown) => error instanceof AgentError
        && error.code === "model_failed"
        && error.message === "The model request failed.",
    );

    const modelEvent = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(modelEvent?.outcome, "external_failure");
    assert.equal(modelEvent?.error_category, "http_401");
    assert.deepEqual(Object.keys(modelEvent ?? {}).sort(), [
      "correlation_id", "duration_ms", "error_category", "event", "outcome", "schema_version", "stage", "timestamp",
    ]);
    assertNoSentinels(captured.events, [
      secretQuestion, secretMessage, "SECRET RESPONSE BODY", "Authorization", "SECRET-AUTHORIZATION", "SECRET-HEADER",
    ]);
  });

  it("records a neutral category from a non-OpenAI router without provider-specific types", async () => {
    const secret = "SECRET LOCAL PROVIDER FAILURE";
    const router: ModelRouter = { async selectTool() {
      throw createModelFailure("request_timeout", false, secret);
    } };
    const captured = captureDiagnostics();

    await assert.rejects(
      runAgentQuestion("SECRET PROMPT", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options),
      (error: unknown) => error instanceof AgentError && error.code === "model_failed",
    );

    const modelEvent = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(modelEvent?.error_category, "request_timeout");
    assertNoSentinels(captured.events, [secret, "SECRET PROMPT"]);
  });

  it("emits allowlisted retry metadata and marks retry usage incomplete", async () => {
    const secret = "SECRET-RETRY-MATERIAL";
    let request = 0;
    const adapter = new OpenAIModelRouter({ async create() {
      request += 1;
      if (request === 1) throw new APIError(503, { secret }, secret, new Headers({ "x-secret": secret }));
      return { status: "completed", output: [], usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 }, secret };
    } }, DEFAULT_OPENAI_MODEL);
    const router = new ReliableModelSelector(adapter, {
      maximumAttempts: 2, jitter: () => 0, delay: async () => undefined,
    });
    const captured = captureDiagnostics();
    const result = await runAgentQuestion(
      "SECRET QUESTION", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options,
    );
    assert.equal(result, NO_TOOL_MESSAGE);
    const attempts = captured.events.filter((event) => event.event === "agent.model.attempt.completed");
    assert.deepEqual(attempts.map((event) => [event.model_attempt, event.retry_decision, event.error_category, event.backoff_ms]), [
      [1, "retry", "http_5xx", 250],
      [2, "not_needed", undefined, undefined],
    ]);
    const stage = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(stage?.total_model_attempt_count, 2);
    assert.equal(stage?.maximum_model_attempts, 2);
    assert.equal(stage?.usage_completeness, "incomplete");
    assert.equal(stage?.post_response_budget_outcome, "within_limit");
    assert.equal(stage?.input_tokens, 7);
    assert.equal(stage?.output_tokens, 2);
    assert.equal(stage?.total_tokens, 9);
    assertNoSentinels(captured.events, [secret, "SECRET QUESTION", "x-secret"]);
  });

  it("preserves complete usage metadata when first-attempt local validation fails", async () => {
    const captured = captureDiagnostics();
    const router: ModelRouter = { async selectTool() { return {
      selection: { kind: "unexpected" },
      usage: { kind: "available", inputTokens: 11, outputTokens: 3, totalTokens: 14 },
      reliability: {
        attemptCount: 1, maximumAttempts: 1, usageCompleteness: "complete", postResponseBudgetOutcome: "within_limit",
      },
    }; } };

    await assert.rejects(
      runAgentQuestion("SECRET PROMPT", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options),
      (error: unknown) => error instanceof AgentError && error.code === "invalid_model_output",
    );
    const stage = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(stage?.outcome, "validation_rejection");
    assert.equal(stage?.usage_completeness, "complete");
    assert.equal(stage?.post_response_budget_outcome, "within_limit");
    assert.deepEqual([stage?.input_tokens, stage?.output_tokens, stage?.total_tokens], [11, 3, 14]);
    assertNoSentinels(captured.events, ["SECRET PROMPT"]);
  });

  it("preserves partial retry usage metadata when second-attempt local validation fails", async () => {
    const captured = captureDiagnostics();
    const retryable = createModelFailure("http_5xx", true, "SECRET RETRY FAILURE", 503);
    let calls = 0;
    const router = new ReliableModelSelector({ async selectTool() {
      calls += 1;
      if (calls === 1) throw retryable;
      return {
        selection: { kind: "unexpected" },
        usage: { kind: "available", inputTokens: 13, outputTokens: 4, totalTokens: 17 },
      };
    } }, {
      maximumAttempts: 2, isRetryable: (error) => error === retryable, delay: async () => undefined,
    });

    await assert.rejects(
      runAgentQuestion("SECRET PROMPT", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options),
      (error: unknown) => error instanceof AgentError && error.code === "invalid_model_output",
    );
    const stage = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(stage?.usage_completeness, "incomplete");
    assert.equal(stage?.post_response_budget_outcome, "within_limit");
    assert.deepEqual([stage?.input_tokens, stage?.output_tokens, stage?.total_tokens], [13, 4, 17]);
    assert.equal(calls, 2);
    assertNoSentinels(captured.events, ["SECRET PROMPT", "SECRET RETRY FAILURE"]);
  });

  it("reports incomplete unknown usage when both provider attempts fail", async () => {
    const captured = captureDiagnostics();
    const failure = createModelFailure("http_5xx", true, "SECRET PROVIDER FAILURE", 503);
    let calls = 0;
    const router = new ReliableModelSelector({ async selectTool() { calls += 1; throw failure; } }, {
      maximumAttempts: 2, isRetryable: (error) => error === failure, delay: async () => undefined,
    });

    await assert.rejects(
      runAgentQuestion("SECRET PROMPT", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options),
      (error: unknown) => error instanceof AgentError && error.code === "model_failed",
    );
    const stage = captured.events.find((event) => event.stage === "model_selection");
    assert.equal(stage?.usage_completeness, "incomplete");
    assert.equal(stage?.post_response_budget_outcome, "unknown");
    assert.equal(stage?.total_model_attempt_count, 2);
    assert.equal("input_tokens" in (stage ?? {}), false);
    assert.equal(calls, 2);
    assertNoSentinels(captured.events, ["SECRET PROMPT", "SECRET PROVIDER FAILURE"]);
  });

  it("classifies absent or invalid successful-response usage as incomplete and unknown", async () => {
    for (const usage of [undefined, { input_tokens: 1, output_tokens: "invalid", total_tokens: 1 }]) {
      const captured = captureDiagnostics();
      const adapter = new OpenAIModelRouter({ async create() {
        return { status: "completed", output: [{ type: "unexpected_private_shape" }], ...(usage === undefined ? {} : { usage }) };
      } }, DEFAULT_OPENAI_MODEL);
      const router = new ReliableModelSelector(adapter);

      await assert.rejects(
        runAgentQuestion("SECRET PROMPT", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined, captured.options),
        (error: unknown) => error instanceof AgentError && error.code === "invalid_model_output",
      );
      const stage = captured.events.find((event) => event.stage === "model_selection");
      assert.equal(stage?.usage_completeness, "incomplete");
      assert.equal(stage?.post_response_budget_outcome, "unknown");
      assert.equal("input_tokens" in (stage ?? {}), false);
      assertNoSentinels(captured.events, ["SECRET PROMPT", "unexpected_private_shape"]);
    }
  });

  it("does not emit OpenAI failure diagnostics when diagnostics are disabled", async () => {
    const lines: string[] = [];
    const router = new OpenAIModelRouter({
      async create() { throw new APIError(403, { message: "SECRET BODY" }, "SECRET MESSAGE", new Headers()); },
    }, DEFAULT_OPENAI_MODEL);

    await assert.rejects(
      runAgentQuestion(
        "SECRET PROMPT", router, new FakeGateway(jsonResult([])), new AbortController().signal, undefined,
        { environment: {}, writer: (line) => lines.push(line) },
      ),
      (error: unknown) => error instanceof AgentError
        && error.code === "model_failed"
        && error.message === "The model request failed.",
    );
    assert.deepEqual(lines, []);
  });

  it("keeps diagnostics disabled unless the environment value is exactly 1", async () => {
    for (const environment of [{}, { MCP_AGENT_DIAGNOSTICS: "0" }, { MCP_AGENT_DIAGNOSTICS: "true" }]) {
      const lines: string[] = [];
      await runAgentQuestion(
        "hello", fixedRouter({ kind: "none" }), new FakeGateway(jsonResult([])), new AbortController().signal,
        undefined, { environment, writer: (line) => lines.push(line) },
      );
      assert.deepEqual(lines, []);
    }
  });

  it("isolates throwing writers and serialization failures from agent behavior", async () => {
    const base = { environment: { MCP_AGENT_DIAGNOSTICS: "1" }, uuid: () => correlationId };
    const throwingWriter = await runAgentQuestion(
      "hello", fixedRouter({ kind: "none" }), new FakeGateway(jsonResult([])), new AbortController().signal,
      undefined, { ...base, writer: () => { throw new Error("writer failure"); } },
    );
    const throwingSerializer = await runAgentQuestion(
      "hello", fixedRouter({ kind: "none" }), new FakeGateway(jsonResult([])), new AbortController().signal,
      undefined, { ...base, writer: () => { throw new Error("must not be reached"); }, serialize: () => { throw new Error("serialize failure"); } },
    );
    const failingRouter = new OpenAIModelRouter({
      async create() { throw new APIError(429, {}, "private", new Headers()); },
    }, DEFAULT_OPENAI_MODEL);
    await assert.rejects(
      runAgentQuestion(
        "hello", failingRouter, new FakeGateway(jsonResult([])), new AbortController().signal,
        undefined, { ...base, writer: () => { throw new Error("writer failure"); } },
      ),
      (error: unknown) => error instanceof AgentError
        && error.code === "model_failed"
        && error.message === "The model request failed.",
    );
    let retryCalls = 0;
    const retryFailure = createModelFailure("http_429", true, "private retry failure", 429);
    const retrying = new ReliableModelSelector({ async selectTool() {
      retryCalls += 1;
      if (retryCalls === 1) throw retryFailure;
      return { selection: { kind: "none" }, usage: { kind: "unavailable" } };
    } }, { maximumAttempts: 2, isRetryable: (error) => error === retryFailure, delay: async () => undefined });
    const retryResult = await runAgentQuestion(
      "hello", retrying, new FakeGateway(jsonResult([])), new AbortController().signal,
      undefined, { ...base, writer: () => { throw new Error("writer failure"); } },
    );
    assert.equal(throwingWriter, NO_TOOL_MESSAGE);
    assert.equal(throwingSerializer, NO_TOOL_MESSAGE);
    assert.equal(retryResult, NO_TOOL_MESSAGE);
    assert.equal(retryCalls, 2);
  });
});

class FakeGateway implements McpGateway {
  public constructor(private readonly result: CallToolResult) {}
  public async initializeAndDiscover(): Promise<readonly DiscoveredTool[]> { return validTools; }
  public async callTool(_name: TrustedToolName, _arguments: Readonly<Record<string, unknown>>): Promise<CallToolResult> { return this.result; }
  public async close(): Promise<void> {}
}

function fixedRouter(selection: ModelSelection, usage: ModelUsage = { kind: "unavailable" }): ModelRouter {
  return { async selectTool(): Promise<ModelRouterResult> { return { selection, usage }; } };
}

function call(name: string, argumentsValue: string): ModelSelection {
  return { kind: "tool_calls", calls: [{ name, arguments: argumentsValue }] };
}

function availableUsage(inputTokens: number, outputTokens: number, totalTokens: number): ModelUsage {
  return { kind: "available", inputTokens, outputTokens, totalTokens };
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function captureDiagnostics(clockValues: readonly number[] = []): {
  options: DiagnosticsOptions;
  events: Array<Record<string, unknown>>;
  uuidCalls: () => number;
} {
  const events: Array<Record<string, unknown>> = [];
  let clockIndex = 0;
  let generated = 0;
  return {
    events,
    uuidCalls: () => generated,
    options: {
      environment: { MCP_AGENT_DIAGNOSTICS: "1" },
      uuid: () => { generated += 1; return correlationId; },
      clock: () => clockValues[clockIndex++] ?? clockIndex,
      timestamp: () => fixedTimestamp,
      writer: (line) => { events.push(JSON.parse(line) as Record<string, unknown>); },
    },
  };
}

function common(event: string): Record<string, unknown> {
  return { schema_version: 1, timestamp: fixedTimestamp.toISOString(), event, correlation_id: correlationId };
}

function isStage(event: Record<string, unknown>): boolean {
  return event.event === "agent.stage.completed";
}

function assertNoSentinels(events: readonly Record<string, unknown>[], sentinels: readonly string[]): void {
  const rendered = JSON.stringify(events);
  for (const sentinel of sentinels) assert.doesNotMatch(rendered, new RegExp(escapeRegex(sentinel), "i"));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
