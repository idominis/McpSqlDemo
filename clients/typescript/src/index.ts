#!/usr/bin/env node
import { CliUsageError, parseCliArgs, USAGE } from "./cli.js";
import { McpClientError, runCommand } from "./client.js";
import { McpResponseError } from "./response.js";

const abortController = new AbortController();
let interrupted = false;

function interrupt(): void {
  interrupted = true;
  abortController.abort();
}

process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const command = parseCliArgs(process.argv.slice(2));
  const output = await runCommand(command, abortController.signal);
  if (!interrupted) console.log(JSON.stringify(output, null, 2));
} catch (error: unknown) {
  if (interrupted) {
    console.error("Interrupted; the MCP server process was stopped.");
    process.exitCode = 130;
  } else if (error instanceof CliUsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof McpResponseError) {
    console.error(error.message);
    process.exitCode = 1;
  } else if (error instanceof McpClientError) {
    console.error(
      `The MCP client could not complete the request (stage=${error.stage}, category=${error.category}, code=${error.code}).`,
    );
    process.exitCode = 1;
  } else {
    console.error("The MCP client could not complete the request. Check the launcher configuration and server availability.");
    process.exitCode = 1;
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
