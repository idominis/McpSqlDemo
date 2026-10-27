import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpResponseError, readJsonToolResult } from "../src/response.js";

describe("readJsonToolResult", () => {
  it("parses the server's JSON text response", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: '[{"id":1,"reference":"DEMO-001","status":"Pending","quantity":12.5}]' }],
    };
    assert.deepEqual(readJsonToolResult(result), [
      { id: 1, reference: "DEMO-001", status: "Pending", quantity: 12.5 },
    ]);
  });

  it("reports an MCP error result without exposing multiline details", () => {
    assert.throws(
      () => readJsonToolResult({ isError: true, content: [{ type: "text", text: "internal\nsecret detail" }] }),
      (error: unknown) => error instanceof McpResponseError && error.message === "The MCP tool reported an error.",
    );
  });

  it("accepts a short, single-line tool error", () => {
    assert.throws(
      () => readJsonToolResult({ isError: true, content: [{ type: "text", text: "Shipment with ID 7 was not found." }] }),
      /Shipment with ID 7 was not found/,
    );
  });

  it("does not expose an unrecognized single-line server error", () => {
    assert.throws(
      () => readJsonToolResult({ isError: true, content: [{ type: "text", text: "unrecognized internal detail" }] }),
      (error: unknown) => error instanceof McpResponseError && error.message === "The MCP tool reported an error.",
    );
  });

  it("rejects invalid JSON and unexpected content", () => {
    assert.throws(() => readJsonToolResult({ content: [{ type: "text", text: "not json" }] }), McpResponseError);
    assert.throws(() => readJsonToolResult({ content: [] }), McpResponseError);
  });

  it("preserves the legacy CLI's unbounded parser unless a caller supplies a limit", () => {
    const payload = JSON.stringify({ value: "x".repeat(70_000) });
    assert.deepEqual(readJsonToolResult({ content: [{ type: "text", text: payload }] }), {
      value: "x".repeat(70_000),
    });
    assert.throws(
      () => readJsonToolResult({ content: [{ type: "text", text: payload }] }, 64 * 1024),
      /too large/,
    );
  });
});
