import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createLauncherEnvironment,
  createLauncherServerParameters,
  McpClientError,
  runCommandWithServer,
} from "../src/client.js";

const mockServer = fileURLToPath(new URL("./mock-stdio-server.js", import.meta.url));

describe("MCP stdio client", () => {
  it("uses the known-working PowerShell launcher arguments and safe process options", () => {
    const launcherPath = "C:\\safe-test-path\\start-mcp.ps1";
    const parameters = createLauncherServerParameters(launcherPath);

    assert.deepEqual(parameters.args, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
    ]);
    assert.equal(parameters.stderr, "pipe");
    assert.equal(parameters.cwd, undefined);
    assert.deepEqual(parameters.env, createLauncherEnvironment());
  });

  it("adds only PATHEXT on Windows to the SDK default child environment", () => {
    const names = ["PATHEXT", "PSModulePath", "DOTNET_ROOT", "MCP_SQL_CONNECTION", "TEST_PASSWORD", "TEST_TOKEN", "TEST_SECRET"] as const;
    const originals = new Map(names.map((name) => [name, process.env[name]]));

    try {
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      process.env.PSModulePath = "diagnostic-module-path";
      process.env.DOTNET_ROOT = "excluded-dotnet-root";
      process.env.MCP_SQL_CONNECTION = "excluded-connection";
      process.env.TEST_PASSWORD = "excluded-password";
      process.env.TEST_TOKEN = "excluded-token";
      process.env.TEST_SECRET = "excluded-secret";

      const environment = createLauncherEnvironment();

      assert.deepEqual(
        environment,
        process.platform === "win32"
          ? { ...getDefaultEnvironment(), PATHEXT: ".COM;.EXE;.BAT;.CMD" }
          : getDefaultEnvironment(),
      );
      for (const excluded of names.slice(1)) assert.equal(excluded in environment, false);
    } finally {
      for (const [name, value] of originals) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("initializes and lists tools through a mock stdio server", async () => {
    const result = await runCommandWithServer({ kind: "tools" }, new AbortController().signal, {
      command: process.execPath,
      args: [mockServer],
      stderr: "ignore",
    });

    assert.deepEqual(result, [
      { name: "list_shipments", description: "Mock list", inputSchema: { type: "object" } },
    ]);
  });

  it("calls a tool and parses its JSON response through a mock stdio server", async () => {
    const result = await runCommandWithServer({ kind: "list" }, new AbortController().signal, {
      command: process.execPath,
      args: [mockServer],
      stderr: "ignore",
    });

    assert.deepEqual(result, [{ id: 1, status: "Pending" }]);
  });

  it("reports a sanitized spawn diagnostic", async () => {
    let caught: unknown;
    try {
      await runCommandWithServer({ kind: "tools" }, new AbortController().signal, {
        command: process.execPath,
        cwd: fileURLToPath(new URL("./directory-that-does-not-exist", import.meta.url)),
        stderr: "ignore",
      });
    } catch (error: unknown) {
      caught = error;
    }

    assert.ok(caught instanceof McpClientError);
    assert.deepEqual(
      {
        stage: caught.stage,
        category: caught.category,
        code: caught.code,
      },
      { stage: "spawn", category: "system", code: "ENOENT" },
    );
  });

  it("reports a sanitized initialization failure", async () => {
    const caught = await captureClientError({
      command: process.execPath,
      args: [mockServer, "reject-initialize"],
      stderr: "ignore",
    });

    assert.deepEqual({ stage: caught.stage, category: caught.category, code: caught.code }, {
      stage: "initialization",
      category: "mcp",
      code: "-32000",
    });
    assert.equal(caught.message, "The MCP client could not complete the request.");
  });
});

type ServerParameters = Parameters<typeof runCommandWithServer>[2];

async function captureClientError(server: ServerParameters): Promise<McpClientError> {
  try {
    await runCommandWithServer({ kind: "tools" }, new AbortController().signal, server);
  } catch (error: unknown) {
    assert.ok(error instanceof McpClientError);
    return error;
  }
  assert.fail("Expected the MCP client to fail.");
}
