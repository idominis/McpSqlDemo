import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

export class McpResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "McpResponseError";
  }
}

export function readJsonToolResult(result: CallToolResult, maximumBytes = Number.POSITIVE_INFINITY): unknown {
  const textBlocks = result.content.filter(
    (block): block is Extract<(typeof result.content)[number], { type: "text" }> =>
      block.type === "text",
  );

  if (result.isError === true) {
    throw new McpResponseError(safeToolError(textBlocks));
  }
  if (result.content.length !== 1 || textBlocks.length !== 1) {
    throw new McpResponseError("The MCP server returned an unexpected response format.");
  }

  const textBlock = textBlocks[0];
  if (textBlock === undefined) {
    throw new McpResponseError("The MCP server returned an unexpected response format.");
  }

  if (Buffer.byteLength(textBlock.text, "utf8") > maximumBytes) {
    throw new McpResponseError("The MCP server returned a result that was too large.");
  }

  try {
    return JSON.parse(textBlock.text) as unknown;
  } catch {
    throw new McpResponseError("The MCP server returned invalid JSON.");
  }
}

function safeToolError(textBlocks: readonly { readonly text: string }[]): string {
  if (textBlocks.length !== 1) return "The MCP tool reported an error.";

  const message = textBlocks[0]?.text.trim();
  if (!message || !isKnownSafeServerMessage(message)) {
    return "The MCP tool reported an error.";
  }
  return `The MCP tool reported an error: ${message}`;
}

function isKnownSafeServerMessage(message: string): boolean {
  return (
    /^Shipment with ID [1-9]\d{0,6} was not found\.$/.test(message) ||
    message === "shipmentId must be between 1 and 1,000,000." ||
    message === "status must be one of: Pending, Loading, Completed." ||
    message === "The shipment operation timed out. Please try again later." ||
    message === "The shipment operation failed. Please try again later." ||
    message === "The shipment database operation failed. Please try again later."
  );
}
