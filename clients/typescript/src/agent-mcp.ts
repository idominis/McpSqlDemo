import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DiscoveredTool, TrustedToolName } from "./contracts.js";
import { createConfiguredLauncherServerParameters, type ServerParameters } from "./client.js";

const AGENT_CLIENT_INFO = { name: "mcpsqldemo-secure-agent", version: "0.1.0" } as const;

export interface McpGateway {
  initializeAndDiscover(signal: AbortSignal): Promise<readonly DiscoveredTool[]>;
  callTool(name: TrustedToolName, argumentsValue: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class StdioMcpGateway implements McpGateway {
  private readonly client = new Client(AGENT_CLIENT_INFO);
  private readonly transport: StdioClientTransport;

  public constructor(server: ServerParameters) {
    this.transport = new StdioClientTransport(server);
  }

  public async initializeAndDiscover(signal: AbortSignal): Promise<readonly DiscoveredTool[]> {
    const abort = (): void => { void this.client.close().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.client.connect(this.transport, { signal, timeout: 10_000 });
      const result = await this.client.listTools(undefined, { signal, timeout: 10_000 });
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      }));
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  public async callTool(
    name: TrustedToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    return this.client.callTool(
      { name, arguments: { ...argumentsValue } },
      undefined,
      { signal, timeout: 15_000 },
    ) as Promise<CallToolResult>;
  }

  public async close(): Promise<void> {
    await this.client.close();
  }
}

export async function createConfiguredMcpGateway(): Promise<McpGateway> {
  return new StdioMcpGateway(await createConfiguredLauncherServerParameters());
}
