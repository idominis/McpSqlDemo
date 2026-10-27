# TypeScript MCP client

A small Node.js CLI that uses the official `@modelcontextprotocol/sdk` stdio client to call the existing McpSqlDemo server. It starts the server only through the separately managed secure PowerShell launcher. The client does not read, copy, print, or persist the launcher's DPAPI material, SQL credentials, or connection string.

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

The unit tests exercise argument parsing and MCP response handling only. They do not start a process, use the launcher, connect to SQL Server, or require LocalDB.

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
