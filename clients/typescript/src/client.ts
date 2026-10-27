import { access } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CliCommand } from "./cli.js";
import { readJsonToolResult } from "./response.js";

const CLIENT_INFO = { name: "mcpsqldemo-typescript-client", version: "0.1.0" } as const;

export type McpFailureStage = "spawn" | "initialization" | "listTools" | "callTool" | "shutdown";

export class McpClientError extends Error {
  public constructor(
    public readonly stage: McpFailureStage,
    public readonly category: string,
    public readonly code: string,
  ) {
    super("The MCP client could not complete the request.");
    this.name = "McpClientError";
  }
}

export async function runCommand(command: CliCommand, signal: AbortSignal): Promise<unknown> {
  const launcherPath = await getLauncherPath();
  return runCommandWithServer(command, signal, createLauncherServerParameters(launcherPath));
}

export function createLauncherServerParameters(launcherPath: string): ServerParameters {
  return {
    command: getPowerShellCommand(),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath],
    env: createLauncherEnvironment(),
    // Server diagnostics can contain operational details; do not relay them to CLI output.
    // Pipe only to count whether bytes were emitted. Content is never retained or exposed.
    stderr: "pipe",
  };
}

/** Preserve the SDK's safe defaults and add only the Windows executable-extension search path. */
export function createLauncherEnvironment(): Record<string, string> {
  const environment = getDefaultEnvironment();
  const pathExt = process.env.PATHEXT;
  if (process.platform === "win32" && pathExt !== undefined && pathExt !== "") {
    environment.PATHEXT = pathExt;
  }
  return environment;
}

type ServerParameters = ConstructorParameters<typeof StdioClientTransport>[0];

/** Used by tests to exercise the real MCP stdio transport without the protected launcher. */
export async function runCommandWithServer(
  command: CliCommand,
  signal: AbortSignal,
  server: ServerParameters,
): Promise<unknown> {
  if (signal.aborted) throw new Error("Operation interrupted.");
  const transport = new StdioClientTransport(server);
  const client = new Client(CLIENT_INFO);
  let stage: McpFailureStage = "initialization";
  let commandCompleted = false;

  const abort = (): void => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    try {
      await client.connect(transport);
    } catch (error: unknown) {
      throw diagnosticError(isSpawnError(error) ? "spawn" : "initialization", error);
    }
    if (signal.aborted) throw new Error("Operation interrupted.");

    if (command.kind === "tools") {
      stage = "listTools";
      const result = await client.listTools().catch((error: unknown) => {
        throw diagnosticError(stage, error);
      });
      const output = result.tools.map(({ name, description, inputSchema }) => ({
        name,
        description: description ?? "",
        inputSchema,
      }));
      commandCompleted = true;
      return output;
    }

    const request = toToolRequest(command);
    stage = "callTool";
    const result = await client.callTool(request).catch((error: unknown) => {
      throw diagnosticError(stage, error);
    });
    if (!Array.isArray(result.content)) {
      throw new Error("The MCP server returned an unsupported tool result.");
    }
    const output = readJsonToolResult(result as CallToolResult);
    commandCompleted = true;
    return output;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await client.close();
    } catch (error: unknown) {
      if (commandCompleted) throw diagnosticError("shutdown", error);
    }
  }
}

function isSpawnError(error: unknown): boolean {
  const code = asErrorWithCode(error)?.code;
  return typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "UNKNOWN"].includes(code);
}

function diagnosticError(stage: McpFailureStage, error: unknown): McpClientError {
  const value = asErrorWithCode(error);
  const code = sanitizeCode(value?.code);
  const category = code === "UNKNOWN" ? "runtime" : typeof value?.code === "number" ? "mcp" : "system";
  return new McpClientError(stage, category, code);
}

function asErrorWithCode(error: unknown): { readonly code?: unknown } | undefined {
  return typeof error === "object" && error !== null ? error : undefined;
}

function sanitizeCode(code: unknown): string {
  if (typeof code === "number" && Number.isSafeInteger(code)) return String(code);
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
  return "UNKNOWN";
}

function toToolRequest(command: Exclude<CliCommand, { kind: "tools" }>): {
  name: string;
  arguments?: Record<string, unknown>;
} {
  switch (command.kind) {
    case "list":
      return { name: "list_shipments" };
    case "get":
      return { name: "get_shipment_by_id", arguments: { shipmentId: command.shipmentId } };
    case "status":
      return { name: "get_shipments_by_status", arguments: { status: command.status } };
  }
}

async function getLauncherPath(): Promise<string> {
  const configured = process.env.MCP_SERVER_LAUNCHER_PATH;
  if (!configured || configured.trim() === "") {
    throw new Error("MCP_SERVER_LAUNCHER_PATH is not configured.");
  }

  if (!path.isAbsolute(configured)) {
    throw new Error("MCP_SERVER_LAUNCHER_PATH must be an absolute path.");
  }

  const launcherPath = path.normalize(configured);
  if (path.extname(launcherPath).toLowerCase() !== ".ps1") {
    throw new Error("MCP_SERVER_LAUNCHER_PATH must identify a PowerShell .ps1 file.");
  }
  try {
    await access(launcherPath);
  } catch {
    throw new Error("The configured MCP server launcher is not accessible.");
  }
  return launcherPath;
}

function getPowerShellCommand(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}
