# TypeScript MCP client and secure AI router

A small Node.js CLI that uses the official `@modelcontextprotocol/sdk` stdio client to call the existing McpSqlDemo server. Phase 4B adds a narrowly scoped AI router built on the official OpenAI TypeScript SDK and Responses API. The model recognizes intent and selects a tool; MCP/SQL results are validated and formatted locally and are never sent to the model.

The client starts the server only through the separately managed secure PowerShell launcher. It does not read, copy, print, or persist the launcher's DPAPI material, SQL credentials, or connection string.

## Requirements

- Node.js 20 or newer (Node.js 22 LTS is tested locally).
- The .NET MCP server already built and the existing secure PowerShell launcher already configured outside this repository.
- Windows PowerShell on Windows. On other operating systems the CLI uses `pwsh`, although a Windows DPAPI-based launcher is inherently Windows-only.

## Install and check

From `clients/typescript`:

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

The tests use a deterministic mock model and a mock MCP stdio process. They do not use an API key, make network requests, invoke the protected launcher, connect to SQL Server, or require LocalDB/DPAPI.

## Configure

Set only the absolute path to the existing launcher for the current process. Do not put credentials, connection strings, or DPAPI payloads in this variable or in command arguments.

```powershell
$env:MCP_SERVER_LAUNCHER_PATH = 'C:\path\outside\the\repository\start-mcp.ps1'
```

The path must identify an accessible `.ps1` file. The CLI passes it to PowerShell with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`. On Windows, it forwards `PATHEXT` in addition to the SDK's restricted default child environment so PowerShell can resolve executable file types without forwarding credentials or unrelated local variables. Server stderr and stdout content and unexpected exception details are never retained or echoed; failures report only a sanitized operation stage, category, and code. The MCP client closes its child process after each command and on `Ctrl+C`/termination.

## Use

```powershell
npm run dev -- list
npm run dev -- get 1
npm run dev -- status Pending
npm run dev -- tools
```

- `list` calls `list_shipments`.
- `get` accepts an integer from 1 through 1,000,000 and calls `get_shipment_by_id`.
- `status` accepts `Pending`, `Loading`, or `Completed` (case-insensitive) and calls `get_shipments_by_status`.
- `tools` performs MCP initialization and prints the server's advertised tool metadata.

All successful tool payloads are parsed from the server's existing JSON text response and printed as formatted JSON. Output is intended for local demonstration; do not redirect shipment data into an untrusted location.

## Secure AI tool selection (Phase 4B)

The agent discovers exactly `list_shipments`, `get_shipment_by_id`, and `get_shipments_by_status`, validates their schemas against local contracts, and sends only locally controlled function names, descriptions, and strict schemas to OpenAI. A small provider-neutral `ModelRouter` interface keeps a future local/Ollama adapter possible without introducing an agent framework. It permits one Responses API request and zero or one MCP tool call. Parallel calls are disabled. Arbitrary model text is never displayed, and shipment results are never returned to OpenAI.

The official `openai` package is pinned exactly to `6.49.0`. The default model is the pinned `gpt-5.4-mini-2026-03-17` snapshot. `OPENAI_MODEL` may be set only to that snapshot or `gpt-5.4-mini`; other values fail before a request. OpenAI's model documentation lists Responses and function calling support for this model: [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

Security limits are fixed in code: 2,000 question characters, one model request, one MCP call, 10-second MCP initialization, 20-second model request, 15-second MCP execution, 45-second overall deadline, 20 records, 64 KiB tool JSON, and 256 maximum model output tokens. Requests use `store: false` and `parallel_tool_calls: false`.

### Test without an OpenAI API key

From `clients/typescript`:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:MCP_SERVER_LAUNCHER_PATH -ErrorAction SilentlyContinue
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

These mandatory checks are fully isolated and make no paid API calls.

### Test manually with a real OpenAI API key

This is the only path that can incur OpenAI API charges and invoke the existing launcher. Set values only in the current PowerShell process; do not place them in source control or command arguments:

```powershell
$env:OPENAI_API_KEY = '<your API key>'
$env:MCP_SERVER_LAUNCHER_PATH = 'C:\path\outside\the\repository\start-mcp.ps1'
# Optional; the default is gpt-5.4-mini-2026-03-17:
$env:OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17'

npm run agent -- "Show me all pending shipments"
```

After testing:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:MCP_SERVER_LAUNCHER_PATH -ErrorAction SilentlyContinue
```

The agent intentionally reports sanitized failures. It never sends launcher paths, environment dumps, SQL credentials, DPAPI material, stack traces, raw MCP errors, or MCP tool results to OpenAI.
