import { createInterface } from "node:readline";

const mode = process.argv[2];

interface Request {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line) as Request;
  if (request.id === undefined) return;

  if (request.method === "initialize") {
    if (mode === "reject-initialize") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "mock failure" } })}\n`,
      );
      return;
    }
    const params = request.params as { readonly protocolVersion?: string } | undefined;
    respond(request.id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp-stdio-server", version: "1.0.0" },
    });
    return;
  }

  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [{ name: "list_shipments", description: "Mock list", inputSchema: { type: "object" } }],
    });
    return;
  }

  if (request.method === "tools/call") {
    respond(request.id, {
      content: [{ type: "text", text: JSON.stringify([{ id: 1, status: "Pending" }]) }],
    });
  }
});

function respond(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
