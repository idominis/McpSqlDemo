import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { TRUSTED_MODEL_TOOLS } from "../src/contracts.js";
import {
  DEFAULT_OPENAI_MODEL,
  MAX_MODEL_OUTPUT_TOKENS,
  OpenAIModelRouter,
  openAIErrorCategory,
  parseOpenAIResponse,
  parseOpenAIUsage,
} from "../src/openai-model-router.js";

describe("OpenAI Responses model router", () => {
  it("uses one bounded, non-stored request with parallel calls disabled and discloses no process secrets", async () => {
    let body: Record<string, unknown> | undefined;
    let options: Record<string, unknown> | undefined;
    let requestCount = 0;
    const secret = "TOP-SECRET-CONNECTION-MATERIAL";
    process.env.MCP_SQL_CONNECTION = secret;
    process.env.MCP_SERVER_LAUNCHER_PATH = `C:\\private\\${secret}.ps1`;
    process.env.DPAPI_BLOB = secret;
    try {
      const client = {
        async create(request: Record<string, unknown>, requestOptions: Record<string, unknown>) {
          requestCount += 1;
          body = request;
          options = requestOptions;
          return { status: "completed", output: [{ type: "function_call", name: "list_shipments", arguments: "{}" }] };
        },
      };
      const result = await new OpenAIModelRouter(client, DEFAULT_OPENAI_MODEL)
        .selectTool("show shipments", TRUSTED_MODEL_TOOLS, new AbortController().signal);

      assert.equal(result.selection.kind, "tool_calls");
      assert.equal(requestCount, 1);
      assert.equal(body?.store, false);
      assert.equal(body?.parallel_tool_calls, false);
      assert.equal(body?.max_output_tokens, MAX_MODEL_OUTPUT_TOKENS);
      assert.deepEqual(
        (body?.tools as Array<Record<string, unknown>>).map((tool) => ({ type: tool.type, strict: tool.strict })),
        TRUSTED_MODEL_TOOLS.map(() => ({ type: "function", strict: true })),
      );
      assert.equal(options?.timeout, 20_000);
      assert.equal(options?.maxRetries, 0);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(body), /MCP_SQL_CONNECTION|DPAPI|launcher/i);
    } finally {
      delete process.env.MCP_SQL_CONNECTION;
      delete process.env.MCP_SERVER_LAUNCHER_PATH;
      delete process.env.DPAPI_BLOB;
    }
  });

  it("rejects unapproved models and unexpected response shapes", () => {
    assert.throws(() => new OpenAIModelRouter({ async create() { return {}; } }, "arbitrary-model"));
    assert.deepEqual(parseOpenAIResponse({ status: "incomplete", output: [] }), { kind: "unexpected" });
    assert.deepEqual(parseOpenAIResponse({ status: "completed", output: [{ type: "web_search_call" }] }), { kind: "unexpected" });
    assert.deepEqual(parseOpenAIResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ignore me" }] }] }), { kind: "none" });
    assert.deepEqual(
      parseOpenAIResponse({ status: "completed", output: [
        { type: "function_call", name: "list_shipments", arguments: "{}" },
        { type: "function_call", name: "list_shipments", arguments: "{}" },
      ] }),
      { kind: "tool_calls", calls: [
        { name: "list_shipments", arguments: "{}" },
        { name: "list_shipments", arguments: "{}" },
      ] },
    );
  });

  it("accepts complete safe usage including zero and rejects unavailable or malformed usage", () => {
    assert.deepEqual(parseOpenAIUsage({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }), {
      kind: "available", inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
    assert.deepEqual(parseOpenAIUsage({ usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }), {
      kind: "available", inputTokens: 12, outputTokens: 3, totalTokens: 15,
    });

    const malformed: readonly unknown[] = [
      {},
      { usage: null },
      { usage: { input_tokens: 1, output_tokens: 2 } },
      { usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } },
      { usage: { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 } },
      { usage: { input_tokens: "1", output_tokens: 2, total_tokens: 3 } },
      { usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0, total_tokens: 0 } },
    ];
    for (const value of malformed) assert.deepEqual(parseOpenAIUsage(value), { kind: "unavailable" });
  });

  it("classifies only trusted SDK errors and validated HTTP statuses", async () => {
    const headers = new Headers();
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [new APIError(400, {}, "private", headers), "http_400"],
      [new APIError(401, {}, "private", headers), "http_401"],
      [new APIError(403, {}, "private", headers), "http_403"],
      [new APIError(404, {}, "private", headers), "http_404"],
      [new APIError(429, {}, "private", headers), "http_429"],
      [new APIError(500, {}, "private", headers), "http_5xx"],
      [new APIError(599, {}, "private", headers), "http_5xx"],
      [new APIConnectionError({ cause: new Error("private cause") }), "network_failure"],
      [new APIConnectionTimeoutError(), "request_timeout"],
      [new APIError(409, {}, "private", headers), "unknown"],
      [new Error("untrusted 401 timeout text"), "unknown"],
    ];

    for (const [failure, category] of cases) {
      assert.equal(await categoryFromFailedRequest(failure), category);
    }
  });

  it("treats missing and malformed SDK status values as unknown", async () => {
    const headers = new Headers();
    const malformed: readonly unknown[] = [
      new APIError(undefined, {}, "private", undefined),
      new APIError("401" as never, {}, "private", headers),
      new APIError(Number.NaN, {}, "private", headers),
      new APIError(401.5, {}, "private", headers),
      new APIError(99, {}, "private", headers),
      new APIError(600, {}, "private", headers),
    ];

    for (const failure of malformed) assert.equal(await categoryFromFailedRequest(failure), "unknown");
  });
});

async function categoryFromFailedRequest(failure: unknown): Promise<string | undefined> {
  const router = new OpenAIModelRouter({ async create() { throw failure; } }, DEFAULT_OPENAI_MODEL);
  try {
    await router.selectTool("offline test", TRUSTED_MODEL_TOOLS, new AbortController().signal);
  } catch (error: unknown) {
    return openAIErrorCategory(error);
  }
  assert.fail("Expected the offline client to reject.");
}
