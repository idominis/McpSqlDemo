import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRUSTED_MODEL_TOOLS } from "../src/contracts.js";
import {
  DEFAULT_OPENAI_MODEL,
  MAX_MODEL_OUTPUT_TOKENS,
  OpenAIModelRouter,
  parseOpenAIResponse,
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
      const selection = await new OpenAIModelRouter(client, DEFAULT_OPENAI_MODEL)
        .selectTool("show shipments", TRUSTED_MODEL_TOOLS, new AbortController().signal);

      assert.equal(selection.kind, "tool_calls");
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
});
