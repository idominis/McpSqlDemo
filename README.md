# MCP SQL Server Demo (.NET 10 / C#)

Learning project: a **read-only** MCP server exposing `GetShipmentById`, `ListShipments`, and `GetShipmentsByStatus` over **stdio**, backed by a local test SQL Server database. No production or company database is used.

## Prerequisites
- .NET 10 SDK (`dotnet --version`); recent VS 2022 tooling may not support targeting .NET 10, so use a compatible IDE/SDK or CLI.
- SQL Server Developer/Express or local SQL Server, SSMS.
- Codex CLI or a Codex IDE extension that supports MCP.

## 1. Create database
Run `sql/setup.sql` in SSMS on your **local test instance**.

## 2. Restore and build
From repository root in PowerShell:

```powershell
dotnet restore .\src\McpSqlDemo\McpSqlDemo.csproj
dotnet build .\src\McpSqlDemo\McpSqlDemo.csproj -c Release
```

NuGet references are pinned to explicit versions for repeatable restores.

## 3. Configure SQL connection
For first-time local testing with Windows authentication:

```powershell
$env:MCP_SQL_CONNECTION = 'Server=localhost;Database=McpSqlDemo;Integrated Security=True;Encrypt=True;TrustServerCertificate=True;Application Name=McpSqlDemo;'
```

Change Server for your own **local** SQL Server instance (e.g. `localhost\SQLEXPRESS`). In a real deployment, use validated TLS certs (avoid `TrustServerCertificate=True`) and read-only SQL permissions. Prefer setting this environment variable for the server process rather than storing credentials in a repository.

This Windows Integrated Security configuration remains the default local-development path. Phase 5C.2 adds an optional SQL-authenticated identity; it does not replace or automatically modify this configuration.

### Optional least-privilege SQL login (Phase 5C.2)

All setup in this section is manual and must be reviewed first. Neither the application nor the tests create logins, users, or permissions.

1. Connect to the intended local instance in SSMS using an administrative Windows identity and check both the instance type and authentication mode:

   ```sql
   SELECT
       SERVERPROPERTY(N'IsLocalDB') AS IsLocalDB,
       SERVERPROPERTY(N'IsIntegratedSecurityOnly') AS IsWindowsAuthenticationOnly;
   ```

   `IsWindowsAuthenticationOnly = 0` means the endpoint accepts both Windows and SQL Server authentication. `1` means that a SQL login will not work on that endpoint. LocalDB runs in the owning user's context and is commonly used with Integrated Security, so check the value rather than assuming SQL authentication is available. See Microsoft's documentation for [`SERVERPROPERTY`](https://learn.microsoft.com/sql/t-sql/functions/serverproperty-transact-sql) and [SQL Server Express LocalDB](https://learn.microsoft.com/sql/database-engine/configure-windows/sql-server-express-localdb).

2. If the result is `1`, do not weaken or patch LocalDB solely for this lab. Either keep Integrated Security and run the MCP process under a dedicated Windows account that has only object-level `SELECT`, or use a normal local SQL Server Express/Developer instance deliberately configured for mixed mode. Keep Windows authentication for administration. [Changing server authentication mode](https://learn.microsoft.com/sql/database-engine/configure-windows/change-server-authentication-mode) is an explicit administrator action and normally requires restarting the SQL Server service.

3. If the result is `0`, use **SSMS Object Explorer > Security > Logins > New Login** to create a SQL Server login named `mcp_app_reader`. Generate a unique strong password directly in an approved local password/secret manager and paste it into the SSMS password fields. Do not put it in a `.sql` file, shell history, source control, issue, chat, or screenshot. Leave only the implicit `public` server role selected; do not select `sysadmin` or any other server role. Do not enable or use `sa`.

4. Review and then manually run `sql/setup-mcp-app-reader.sql` on that same instance. It creates the mapped database user when needed, rejects unexpected role membership or permissions, grants only object-level `SELECT` on `dbo.Shipments`, and explicitly denies `INSERT`, `UPDATE`, `DELETE`, and `ALTER`. It never uses `db_owner`, `db_datareader`, or a schema-level grant and contains no password or dynamic SQL.

5. Construct the MCP connection at process startup with `User ID=mcp_app_reader`, the password read from the secret manager, `Integrated Security=False`, encryption enabled, and the `McpSqlDemo` database selected. Validate the server certificate outside throwaway local development. Do not echo the value or pass it as a command-line argument.

Store the credential outside this repository in an OS-backed or organization-approved secret manager, scoped to the account that launches Codex/MCP. Prefer a short launcher that reads the secret, constructs `MCP_SQL_CONNECTION` only in the current process environment, starts Codex, and then clears its local variables. Do not use `setx`, a committed settings file, an MCP registration command containing the connection string, or an `.env` file as a password store. Environment variables can still be inspected by sufficiently privileged same-user processes, so restrict account access and rotate the credential if it is exposed. Application and test failures intentionally omit connection strings, passwords, and raw SQL Server error messages; preserve that behavior when adding diagnostics.

Optional security limits use safe defaults and are bounded even when larger values are configured:

| Environment variable | Default | Allowed range |
| --- | ---: | ---: |
| `MCP_SQL_CONNECTION_TIMEOUT_SECONDS` | 5 seconds | 1–30 seconds |
| `MCP_SQL_COMMAND_TIMEOUT_SECONDS` | 10 seconds | 1–120 seconds |
| `MCP_TOOL_EXECUTION_DEADLINE_SECONDS` | 15 seconds | 1–120 seconds |
| `MCP_TOOL_MAX_CONCURRENCY` | 4 calls | 1–16 calls |

Invalid non-numeric values fall back to the default; numeric values outside the range are clamped to the nearest bound. The execution deadline includes time waiting for a concurrency permit.

## 4. Register with Codex
Compile first. From PowerShell (same session where the Integrated Security `MCP_SQL_CONNECTION` was set):

```powershell
codex mcp add mcp-sql-demo --env MCP_SQL_CONNECTION="$env:MCP_SQL_CONNECTION" -- dotnet "C:\path\to\McpSqlDemo\src\McpSqlDemo\bin\Release\net10.0\McpSqlDemo.dll"
codex mcp list
```

Replace the absolute path with your actual location. **Do not use a SQL password in a command line**: command arguments/configuration can be visible. If your connection string contains secrets, configure it through a secure environment mechanism and limit file access. Restart Codex/IDE after registering.

The `--env` example above is for the passwordless Integrated Security connection only. For SQL authentication, register the server command without embedding `MCP_SQL_CONNECTION`; launch Codex through the reviewed secret-loading mechanism so the MCP child inherits the process-scoped variable. If the client cannot safely inherit or retrieve the secret, keep Integrated Security instead of persisting a password in MCP configuration.

## 5. Test in Codex
Ask: `Using mcp-sql-demo, list demo shipments.` Then ask: `Get shipment with ID 2.`

If the tools are not visible, review `codex mcp list`, ensure .NET 10 runtime is installed, run `dotnet build`, and check the SQL connection. A stdio MCP server will appear to hang if started directly because it is waiting for JSON-RPC messages: that is normal.

## 6. Run automated tests

Unit tests use an in-memory repository fake and never connect to SQL Server:

```powershell
dotnet test .\tests\McpSqlDemo.Tests\McpSqlDemo.Tests.csproj --filter "Category!=Integration"
```

The integration tests are read-only and use `MCP_SQL_CONNECTION`. They are skipped with an explanation when the variable is absent. They never create, update, delete, or seed data:

```powershell
dotnet test .\tests\McpSqlDemo.Tests\McpSqlDemo.Tests.csproj --filter "Category=Integration"
```

The database-permission integration test uses `EXECUTE AS USER = 'mcp_demo_reader'` on the configured connection and checks `HAS_PERMS_BY_NAME` for `dbo.Shipments`. This verifies the database permissions assigned to that user; it does **not** prove that the production MCP process connects under a restricted identity.

After an administrator has completed and reviewed the optional `mcp_app_reader` setup, run the real-connection security check explicitly in the same process where the secret-backed connection is available:

```powershell
$env:MCP_SQL_VERIFY_LEAST_PRIVILEGE = '1'
dotnet test .\tests\McpSqlDemo.Tests\McpSqlDemo.Tests.csproj -c Debug --filter "FullyQualifiedName~LeastPrivilegeSqlAuthenticationIntegrationTests" --logger "console;verbosity=detailed"
Remove-Item Env:MCP_SQL_VERIFY_LEAST_PRIVILEGE
Remove-Item Env:MCP_SQL_CONNECTION
```

The test never uses `EXECUTE AS`. It requires SQL authentication, requires the original login, current login, and database principal all to be `mcp_app_reader`, rejects `sysadmin`, `db_owner`, and `db_datareader`, and verifies that only `SELECT` is effective on `dbo.Shipments`. Consequently, a `dbo` or privileged administrative connection cannot accidentally pass. The test is skipped unless both `MCP_SQL_CONNECTION` is present and `MCP_SQL_VERIFY_LEAST_PRIVILEGE` is exactly `1`.

To run only the opt-in end-to-end MCP stdio test against the Release server build, use the same PowerShell session in which the secret-backed connection is already available:

```powershell
if ([string]::IsNullOrWhiteSpace($env:MCP_SQL_CONNECTION)) { throw 'MCP_SQL_CONNECTION is required.' }
$env:MCP_SQL_RUN_STDIO_INTEGRATION = '1'
try {
    dotnet test .\tests\McpSqlDemo.Tests\McpSqlDemo.Tests.csproj -c Release --filter "FullyQualifiedName=McpStdioIntegrationTests.ListShipments_ThroughStdio_ReturnsValidShipmentData" --logger "console;verbosity=detailed"
}
finally {
    Remove-Item Env:MCP_SQL_RUN_STDIO_INTEGRATION -ErrorAction SilentlyContinue
}
```

This test launches the built `McpSqlDemo.dll` through the official .NET MCP stdio client, invokes `list_shipments`, and forwards only a curated process environment plus `MCP_SQL_CONNECTION`. It does not print or persist the connection string. Child-process stderr is reduced to sanitized event counters, and the child is terminated during client disposal. The test is skipped unless both `MCP_SQL_CONNECTION` is present and `MCP_SQL_RUN_STDIO_INTEGRATION` is exactly `1`.

## TypeScript MCP client

`clients/typescript` contains a strict TypeScript/Node.js CLI that initializes an MCP session over stdio, lists tools, and calls all three shipment tools through the existing external secure PowerShell launcher. It never needs direct access to DPAPI data or SQL configuration. On Windows, the client preserves the SDK's restricted default child environment and additionally forwards only `PATHEXT`, which PowerShell needs to resolve executable file types reliably.

After running `npm ci` in that directory, set `MCP_SERVER_LAUNCHER_PATH` to the launcher's absolute `.ps1` path and use `npm run dev -- list`, `get 1`, `status Pending`, or `tools`. See [the TypeScript client README](clients/typescript/README.md) for setup, security behavior, and checks.

## Continuous integration

GitHub Actions runs on Ubuntu for pushes to `main` and pull requests targeting `main`. It builds the MCP server in Release configuration and runs the MCP server unit tests plus both security-lab test projects. It also installs Node.js LTS and runs `npm ci`, typechecking, build, and isolated unit tests for the TypeScript client. SQL Server and MCP stdio integration tests are skipped cleanly because CI provides no SQL connection, no launcher path, and leaves their explicit opt-ins disabled; the workflow does not require SQL Server, LocalDB, DPAPI, or repository secrets and never starts the real launcher.

## Architecture
Codex (MCP client) -> stdio -> C# MCP server -> SqlClient (parameterized SELECT) -> SQL Server test DB.

## Boundaries / TODO
- No dynamic SQL, writes, or unrestricted query tools.
- No actual company data; never point this at production TMS.
- Add pagination, telemetry, and threat modeling before discussing production readiness. The Phase 5C.2 SQL login is a prepared local option and still requires manual administrator review and setup.
