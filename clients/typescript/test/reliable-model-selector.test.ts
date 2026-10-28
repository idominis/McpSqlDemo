import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AgentError, runAgentQuestion, type AgentLimits } from "../src/agent.js";
import type { McpGateway } from "../src/agent-mcp.js";
import type { DiscoveredTool, TrustedToolName } from "../src/contracts.js";
import type { ModelAttemptDiagnostic, ModelRouter, ModelRouterResult } from "../src/model-router.js";
import {
  DEFAULT_OPENAI_MODEL, isRetryableOpenAIError, openAIErrorCategory, OpenAIModelRouter,
} from "../src/openai-model-router.js";
import { modelMaximumAttempts, ReliableModelSelector } from "../src/reliable-model-selector.js";

const none: ModelRouterResult = { selection: { kind: "none" }, usage: { kind: "unavailable" } };
const call: ModelRouterResult = {
  selection: { kind: "tool_calls", calls: [{ name: "list_shipments", arguments: "{}" }] },
  usage: { kind: "available", inputTokens: 10, outputTokens: 2, totalTokens: 12 },
};

describe("ReliableModelSelector", () => {
  it("defaults to exactly one attempt and reports complete known usage", async () => {
    let calls = 0;
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const selector = new ReliableModelSelector({ async selectTool() { calls += 1; return call; } });
    const result = await selector.selectTool("list", [], new AbortController().signal, {
      timeoutMs: 20_000, onAttempt: (value) => diagnostics.push(value),
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.reliability, {
      attemptCount: 1, maximumAttempts: 1, usageCompleteness: "complete", postResponseBudgetOutcome: "within_limit",
    });
    assert.deepEqual(diagnostics, [{ attempt: 1, maximumAttempts: 1, outcome: "success", retryDecision: "not_needed" }]);
  });

  it("accepts only the documented exact retry configuration values", () => {
    const valid: ReadonlyArray<readonly [string | undefined, 1 | 2]> = [
      [undefined, 1], ["1", 1], ["2", 2],
    ];
    for (const [value, expected] of valid) {
      const environment: NodeJS.ProcessEnv = {};
      if (value !== undefined) environment.MCP_MODEL_MAX_ATTEMPTS = value;
      assert.equal(modelMaximumAttempts(environment), expected);
    }

    for (const value of ["", " ", "\t", " 1 ", " 2 ", "0", "3", "01", "2.0", "true", "private-value"]) {
      assert.throws(
        () => modelMaximumAttempts({ MCP_MODEL_MAX_ATTEMPTS: value }),
        (error: unknown) => error instanceof Error
          && error.message === "MCP_MODEL_MAX_ATTEMPTS must be 1 or 2.",
      );
    }
  });

  it("marks a successful attempt with absent usage as incomplete and budget-unknown", async () => {
    const result = await new ReliableModelSelector({ async selectTool() { return none; } })
      .selectTool("list", [], new AbortController().signal, { timeoutMs: 20_000 });
    assert.deepEqual(result.reliability, {
      attemptCount: 1, maximumAttempts: 1, usageCompleteness: "incomplete", postResponseBudgetOutcome: "unknown",
    });
  });

  for (const status of [429, 503] as const) {
    it(`retries HTTP ${status} once and then succeeds`, async () => {
      const attempts: ModelAttemptDiagnostic[] = [];
      const timeouts: number[] = [];
      let request = 0;
      const adapter = new OpenAIModelRouter({
        async create(_body, options) {
          request += 1;
          timeouts.push(options.timeout);
          if (request === 1) throw new APIError(status, { secret: "PRIVATE-BODY" }, "PRIVATE-MESSAGE", new Headers());
          return { status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } };
        },
      }, DEFAULT_OPENAI_MODEL);
      let now = 0;
      const selector = new ReliableModelSelector(adapter, {
        maximumAttempts: 2,
        monotonicNow: () => now,
        jitter: () => 0,
        delay: async (ms) => { assert.equal(ms, 250); now += ms; },
        isRetryable: isRetryableOpenAIError,
        failureCategory: openAIErrorCategory,
      });
      const result = await selector.selectTool("hello", [], new AbortController().signal, {
        timeoutMs: 2_000, onAttempt: (value) => attempts.push(value),
      });
      assert.equal(request, 2);
      assert.deepEqual(timeouts, [2_000, 1_750]);
      assert.equal(result.reliability?.usageCompleteness, "incomplete");
      assert.equal(attempts[0]?.retryDecision, "retry");
      assert.equal(attempts[0]?.failureCategory, status === 429 ? "http_429" : "http_5xx");
      assert.equal(attempts[0]?.backoffMs, 250);
    });
  }

  it("stops after two retryable failures", async () => {
    let requests = 0;
    const adapter = openAIFailureAdapter(() => { requests += 1; return new APIError(500, {}, "private", new Headers()); });
    const decisions: string[] = [];
    const selector = reliableOpenAI(adapter, { delay: async () => undefined });
    await assert.rejects(selector.selectTool("x", [], new AbortController().signal, {
      timeoutMs: 2_000, onAttempt: (value) => decisions.push(value.retryDecision),
    }));
    assert.equal(requests, 2);
    assert.deepEqual(decisions, ["retry", "attempt_limit"]);
  });

  it("does not retry noneligible statuses, generic network errors, or request timeouts", async () => {
    const failures = [
      ...[400, 401, 403, 404, 501, 505].map((status) => new APIError(status, {}, "private", new Headers())),
      new APIConnectionError({ cause: new Error("private") }),
      new APIConnectionTimeoutError(),
      new Error("429 misleading text"),
    ];
    for (const failure of failures) {
      let requests = 0;
      const selector = reliableOpenAI(openAIFailureAdapter(() => { requests += 1; return failure; }));
      await assert.rejects(selector.selectTool("x", [], new AbortController().signal, { timeoutMs: 1_000 }));
      assert.equal(requests, 1);
    }
  });

  it("honors cancellation before and during an attempt", async () => {
    const before = new AbortController();
    before.abort();
    let calls = 0;
    const selector = new ReliableModelSelector({ async selectTool() { calls += 1; return none; } }, { maximumAttempts: 2 });
    await assert.rejects(selector.selectTool("x", [], before.signal, { timeoutMs: 100 }));
    assert.equal(calls, 0);

    const during = new AbortController();
    const pending: ModelRouter = { selectTool: (_q, _t, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) };
    const operation = new ReliableModelSelector(pending, { maximumAttempts: 2 })
      .selectTool("x", [], during.signal, { timeoutMs: 1_000 });
    during.abort();
    await assert.rejects(operation);
  });

  it("aborts during backoff without starting a second attempt", async () => {
    const controller = new AbortController();
    let calls = 0;
    const retryable = new Error("private");
    const selector = new ReliableModelSelector({ async selectTool() { calls += 1; throw retryable; } }, {
      maximumAttempts: 2,
      isRetryable: (error) => error === retryable,
      delay: (_ms, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const operation = selector.selectTool("x", [], controller.signal, { timeoutMs: 2_000 });
    controller.abort();
    await assert.rejects(operation);
    assert.equal(calls, 1);
  });

  it("does not retry when the deadline cannot contain backoff plus another attempt", async () => {
    let calls = 0;
    const failure = new Error("private");
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const selector = new ReliableModelSelector({ async selectTool() { calls += 1; throw failure; } }, {
      maximumAttempts: 2, monotonicNow: () => 0, jitter: () => 0,
      isRetryable: () => true, delay: async () => assert.fail("delay must not run"),
    });
    await assert.rejects(selector.selectTool("x", [], new AbortController().signal, {
      timeoutMs: 250, onAttempt: (value) => diagnostics.push(value),
    }));
    assert.equal(calls, 1);
    assert.equal(diagnostics[0]?.retryDecision, "deadline_exhausted");
  });

  it("does not dispatch when the absolute deadline expires at the router boundary", async () => {
    let providerRequests = 0;
    const adapter = new OpenAIModelRouter({ async create() { providerRequests += 1; return {}; } }, DEFAULT_OPENAI_MODEL);
    const clockValues = [0, 999, 1_000];
    let clockIndex = 0;
    const selector = new ReliableModelSelector(adapter, {
      monotonicNow: () => clockValues[clockIndex++] ?? 1_000,
    });

    await assert.rejects(
      selector.selectTool("x", [], new AbortController().signal, { timeoutMs: 1_000 }),
      /deadline exhausted/i,
    );
    assert.equal(providerRequests, 0);
  });

  it("does not dispatch a retry when selector-to-adapter clock drift leaves 999 ms", async () => {
    let providerRequests = 0;
    const providerTimeouts: number[] = [];
    const adapter = new OpenAIModelRouter({ async create(_body, options) {
      providerRequests += 1;
      providerTimeouts.push(options.timeout);
      if (providerRequests === 1) throw new APIError(503, {}, "private", new Headers());
      return { status: "completed", output: [{ type: "function_call", name: "list_shipments", arguments: "{}" }] };
    } }, DEFAULT_OPENAI_MODEL);
    const clockValues = [0, 0, 0, 0, 1_000, 1_000, 1_001, 1_001];
    let clockIndex = 0;
    const selector = new ReliableModelSelector(adapter, {
      maximumAttempts: 2,
      monotonicNow: () => clockValues[clockIndex++] ?? 1_001,
      jitter: () => 0,
      delay: async (ms) => { assert.equal(ms, 250); },
      isRetryable: isRetryableOpenAIError,
      failureCategory: openAIErrorCategory,
    });
    const gateway = new FakeGateway();

    await assert.rejects(
      runAgentQuestion("list", selector, gateway, new AbortController().signal, {
        initializationMs: 10_000, modelMs: 2_000, toolMs: 15_000, overallMs: 45_000, shutdownMs: 2_000,
      }),
      (error: unknown) => error instanceof AgentError
        && error.code === "model_failed"
        && error.message === "The model request failed.",
    );
    assert.equal(providerRequests, 1);
    assert.deepEqual(providerTimeouts, [2_000]);
    assert.equal(gateway.executionCount, 0);
  });

  it("never dispatches for invalid budgets or a non-finite monotonic clock", async () => {
    let calls = 0;
    const adapter: ModelRouter = { async selectTool() { calls += 1; return none; } };
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        new ReliableModelSelector(adapter).selectTool("x", [], new AbortController().signal, { timeoutMs }),
        /deadline exhausted/i,
      );
    }
    await assert.rejects(
      new ReliableModelSelector(adapter, { monotonicNow: () => Number.NaN })
        .selectTool("x", [], new AbortController().signal, { timeoutMs: 1_000 }),
      /deadline exhausted/i,
    );
    assert.equal(calls, 0);
  });

  it("re-enforces the minimum second-attempt budget after a delayed backoff", async () => {
    let calls = 0;
    let now = 0;
    const failure = new Error("private");
    const selector = new ReliableModelSelector({ async selectTool() { calls += 1; throw failure; } }, {
      maximumAttempts: 2,
      monotonicNow: () => now,
      jitter: () => 0,
      isRetryable: (error) => error === failure,
      delay: async () => { now = 1_001; },
    });

    await assert.rejects(
      selector.selectTool("x", [], new AbortController().signal, { timeoutMs: 2_000 }),
      /deadline exhausted/i,
    );
    assert.equal(calls, 1);
  });

  it("lets cancellation win when it races a retryable rejection", async () => {
    const controller = new AbortController();
    let calls = 0;
    let delays = 0;
    const failure = new Error("private");
    const selector = new ReliableModelSelector({ async selectTool() {
      calls += 1;
      controller.abort();
      throw failure;
    } }, {
      maximumAttempts: 2,
      isRetryable: (error) => error === failure,
      delay: async () => { delays += 1; },
    });

    await assert.rejects(selector.selectTool("x", [], controller.signal, { timeoutMs: 2_000 }));
    assert.equal(calls, 1);
    assert.equal(delays, 0);
  });

  it("cleans up the real backoff abort listener and never starts a late retry", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let abortListenersAdded = 0;
    let abortListenersRemoved = 0;
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "abort") abortListenersAdded += 1;
      originalAdd(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "abort") abortListenersRemoved += 1;
      originalRemove(type, listener, options);
    }) as typeof signal.removeEventListener;
    let calls = 0;
    const failure = new Error("private");
    const operation = new ReliableModelSelector({ async selectTool() { calls += 1; throw failure; } }, {
      maximumAttempts: 2, jitter: () => 0, isRetryable: (error) => error === failure,
    }).selectTool("x", [], signal, { timeoutMs: 2_000 });
    setImmediate(() => controller.abort());

    await assert.rejects(operation);
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.equal(calls, 1);
    assert.equal(abortListenersAdded, 1);
    assert.equal(abortListenersRemoved, 1);
  });

  it("rejects a late completion and never executes MCP", async () => {
    let resolveModel: ((value: ModelRouterResult) => void) | undefined;
    const adapter: ModelRouter = { selectTool: () => new Promise((resolve) => { resolveModel = resolve; }) };
    const gateway = new FakeGateway();
    const limits: AgentLimits = { initializationMs: 20, modelMs: 5, toolMs: 20, overallMs: 50, shutdownMs: 5 };
    await assert.rejects(
      runAgentQuestion("list", new ReliableModelSelector(adapter, { maximumAttempts: 2 }), gateway, new AbortController().signal, limits),
      (error: unknown) => error instanceof AgentError && error.code === "model_timeout",
    );
    resolveModel?.(call);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gateway.executionCount, 0);
  });

  it("does not retry an invalid model response after one eligible failure and executes zero MCP tools", async () => {
    let calls = 0;
    const retryableFailure = new Error("private retryable failure");
    const adapter: ModelRouter = { async selectTool() {
      calls += 1;
      if (calls === 1) throw retryableFailure;
      return { selection: { kind: "unexpected" }, usage: { kind: "unavailable" } };
    } };
    const gateway = new FakeGateway();
    await assert.rejects(
      runAgentQuestion("list", new ReliableModelSelector(adapter, {
        maximumAttempts: 2, isRetryable: (error) => error === retryableFailure, delay: async () => undefined,
      }), gateway, new AbortController().signal),
      (error: unknown) => error instanceof AgentError && error.code === "invalid_model_output",
    );
    assert.equal(calls, 2);
    assert.equal(gateway.executionCount, 0);
  });

  it("executes exactly one MCP tool after a retry succeeds and ignores cleanup failure", async () => {
    let calls = 0;
    const failure = new Error("retryable");
    const adapter: ModelRouter = { async selectTool() { calls += 1; if (calls === 1) throw failure; return call; } };
    const gateway = new FakeGateway(true);
    const selector = new ReliableModelSelector(adapter, {
      maximumAttempts: 2, isRetryable: (error) => error === failure, delay: async () => undefined,
    });
    const output = await runAgentQuestion("list", selector, gateway, new AbortController().signal);
    assert.match(output, /SHP-001/);
    assert.equal(calls, 2);
    assert.equal(gateway.executionCount, 1);
  });
});

function openAIFailureAdapter(factory: () => unknown): OpenAIModelRouter {
  return new OpenAIModelRouter({ async create() { throw factory(); } }, DEFAULT_OPENAI_MODEL);
}

function reliableOpenAI(adapter: ModelRouter, overrides: { delay?: (ms: number, signal: AbortSignal) => Promise<void> } = {}): ReliableModelSelector {
  return new ReliableModelSelector(adapter, {
    maximumAttempts: 2, jitter: () => 0, delay: overrides.delay ?? (async () => undefined),
    isRetryable: isRetryableOpenAIError, failureCategory: openAIErrorCategory,
  });
}

const validTools: readonly DiscoveredTool[] = [
  { name: "list_shipments", inputSchema: { type: "object", properties: {} } },
  { name: "get_shipment_by_id", inputSchema: { type: "object", properties: { shipmentId: { type: "integer" } }, required: ["shipmentId"] } },
  { name: "get_shipments_by_status", inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] } },
];

class FakeGateway implements McpGateway {
  public executionCount = 0;
  public constructor(private readonly failClose = false) {}
  public async initializeAndDiscover(): Promise<readonly DiscoveredTool[]> { return validTools; }
  public async callTool(_name: TrustedToolName, _arguments: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    this.executionCount += 1;
    return { content: [{ type: "text", text: JSON.stringify([{ id: 1, reference: "SHP-001", status: "Pending", quantity: 1 }]) }] };
  }
  public async close(): Promise<void> { if (this.failClose) throw new Error("private cleanup failure"); }
}
