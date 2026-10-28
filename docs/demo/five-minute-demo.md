# McpSqlDemo five-minute interview demo

This runbook presents the implemented McpSqlDemo as a Senior .NET / Agentic Systems Engineer portfolio demonstration. It deliberately separates current behavior from the proposed legacy-enterprise design. Use only the repository's synthetic local shipment data; never point the demo at a production or company database.

## Demo contract

- Repository root: `C:\Users\Ivan\source\repos\McpSqlDemo`
- Live-command working directory: `C:\Users\Ivan\source\repos\McpSqlDemo\clients\typescript`
- Expected baseline: branch `main`, commit `f71697a71a4877e5c36785bca05bdc136d9cd26e`
- Implemented: a .NET 10 MCP stdio server, three bounded read-only shipment tools, a TypeScript MCP client, and an OpenAI-assisted tool-selection agent.
- Proposed only: authentication/session hosting, identity propagation, an Anti-Corruption Layer (ACL), a legacy application service, enterprise authorization, and rollout infrastructure.

The authoritative implementation references are the [repository overview](../../README.md), [TypeScript client guide](../../clients/typescript/README.md), [trust-boundary analysis](../architecture/trust-boundaries.md), [model-selection ADR](../architecture/adr/0001-model-selection-without-data-feedback.md), and [legacy-integration blueprint](../architecture/legacy-integration-blueprint.md).

## Pre-demo checklist

Complete preparation before screen sharing. Do not display shell history, environment dumps, launcher source, DPAPI material, connection strings, or credentials.

1. Confirm .NET 10 and build the existing server from the repository root:

   ```powershell
   Set-Location 'C:\Users\Ivan\source\repos\McpSqlDemo'
   dotnet --version
   dotnet build .\src\McpSqlDemo\McpSqlDemo.csproj -c Release
   ```

   The SDK must support .NET 10 and the build must succeed.

   If the normal Release build reports a locked output DLL, stop preparation. Close only the known demo MCP session through its normal shutdown mechanism, confirm that session has exited, and then retry the build. Never kill all `dotnet` processes, terminate unrelated services, weaken permissions, or modify the protected launcher.

2. Prepare a local SQL Server instance with the synthetic data from [`sql/setup.sql`](../../sql/setup.sql). Configure `MCP_SQL_CONNECTION` securely in the launcher process. Do not print it or use it as a command argument. Prefer the documented least-privilege identity; confirm the target is the local `McpSqlDemo` database before the interview.

3. Configure the separately managed protected PowerShell launcher outside this repository. In the private current process, set `MCP_SERVER_LAUNCHER_PATH` to its absolute `.ps1` path. The variable contains a path only—never credentials, a connection string, or DPAPI data. A non-disclosing readiness check is:

   ```powershell
   if ([string]::IsNullOrWhiteSpace($env:MCP_SERVER_LAUNCHER_PATH) -or -not (Test-Path -LiteralPath $env:MCP_SERVER_LAUNCHER_PATH -PathType Leaf)) { throw 'Protected launcher is not configured or accessible.' }
   ```

4. Confirm Node.js 20 or newer and install the locked dependencies before the interview:

   ```powershell
   Set-Location 'C:\Users\Ivan\source\repos\McpSqlDemo\clients\typescript'
   node --version
   npm ci
   ```

5. Set `OPENAI_API_KEY` through an approved secret-entry mechanism in the current process only. Never paste it while sharing, store it in the repository, use `setx`, or run a command that prints it. This check discloses only presence:

   ```powershell
   if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'OPENAI_API_KEY is not configured in this process.' }
   ```

6. Use the approved pinned model. The implementation also permits the moving alias `gpt-5.4-mini`, but the reproducible interview setting is:

   ```powershell
   $env:OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17'
   ```

7. Leave optional diagnostics disabled for the cleanest demo. They are disabled when unset or not exactly `1`:

   ```powershell
   Remove-Item Env:MCP_AGENT_DIAGNOSTICS -ErrorAction SilentlyContinue
   ```

   If diagnostics are needed during rehearsal, `MCP_AGENT_DIAGNOSTICS=1` emits sanitized JSON Lines to stderr. Do not enable it casually on a shared screen.

8. Use a large-font PowerShell terminal already positioned at `clients\typescript`. Clear scrollback, notifications, unrelated tabs, and command history from view. Keep this runbook open separately. Rehearse the live path once with only synthetic records, but do not depend on particular row values.

## Live five-minute presentation

All four commands below run from:

```powershell
Set-Location 'C:\Users\Ivan\source\repos\McpSqlDemo\clients\typescript'
```

| Time | Command or action | Expected output type | Protected launcher | SQL query | OpenAI credits |
| --- | --- | --- | :---: | :---: | :---: |
| 0:00–0:40 | Architecture introduction; no command | Spoken architecture overview | No | No | No |
| 0:40–1:20 | `npm run dev -- tools` | JSON array of discovered tool metadata and input schemas | Yes | No | No |
| 1:20–2:00 | `npm run dev -- get 1` | One parsed shipment JSON object, or a sanitized not-found/failure message | Yes | Yes: fixed parameterized lookup | No |
| 2:00–3:15 | `npm run agent -- "Show me all pending shipments"` | A locally formatted bounded shipment result, the supported no-tool message, or a sanitized failure | Yes | Conditional on one valid selected tool | Yes, if the provider request is reached; one attempt by default |
| 3:15–3:50 | `npm run dev -- status Delayed` | Local usage error and supported statuses; exit code 2 | No | No | No |
| 3:50–5:00 | Privacy boundary and proposed legacy integration; no command | Spoken architecture close | No | No | No |

Do not narrate a specific shipment reference, quantity, row count, or model decision in advance. Those are live outcomes.

### 0:00–0:40 — Architecture introduction

**Say:** “This is a local read-only .NET 10 MCP server backed by SQL Server. A TypeScript client talks to it over stdio. The agentic path uses the model for one narrow decision—select zero or one trusted tool—while discovery, validation, SQL execution, result validation, and formatting stay local. The external model never receives SQL-derived data.”

**Engineering concept:** MCP separates the tool contract from the client and model provider. Stdio is a good local-demo transport because the client owns the child-process lifetime and no listening port, network service, or remote authentication surface is needed. It is not presented as the enterprise transport.

**Fallback:** If time or terminal readiness is poor, show the architecture in the [README](../../README.md#architecture-at-a-glance) and continue with the offline presentation.

### 0:40–1:20 — MCP discovery

```powershell
npm run dev -- tools
```

**Say:** “The client starts the server only through the separately protected launcher, establishes MCP over stdio, and asks the server for its tools. This is live protocol discovery, not a hard-coded printout. Discovery should return metadata for exactly the three shipment tools. No tool is invoked, so no SQL query runs.”

**Engineering concept:** The live client exposes MCP capability discovery. In the agent path, discovery is more than convenience: the complete names and structural schemas must match the locally trusted contract before any model request is allowed. Descriptions discovered from the server are not trusted as model instructions; locally controlled definitions are sent instead.

**Likely failure and fallback:** A missing/inaccessible launcher, .NET startup failure, or contract/startup problem produces a sanitized client failure. Do not bypass the launcher. Show [`ShipmentTools.cs`](../../src/McpSqlDemo/ShipmentTools.cs) and the mocked discovery tests in [`client.test.ts`](../../clients/typescript/test/client.test.ts), then move to the offline path.

### 1:20–2:00 — Deterministic query

```powershell
npm run dev -- get 1
```

**Say:** “This maps a locally parsed integer to `get_shipment_by_id`. The server validates the ID again, and the repository executes a fixed `SELECT` with a typed `@Id` parameter. There is no arbitrary SQL surface and no model call. The direct CLI validates the MCP response envelope and parses its JSON, but it does not independently enforce the agent’s exact shipment schema or 64 KiB acceptance bound. The SQL result itself is server-bounded.”

**Engineering concept:** Deterministic routing, validation at both sides of the process boundary, parameterized SQL, cancellation/timeouts, and sanitized failures.

**Likely failure and fallback:** ID `1` is a demo convenience, not a guaranteed record. If it is absent, state that not-found is the correct bounded outcome; do not alter data during the interview. Use `npm run dev -- list` only if the prepared synthetic database is healthy and time permits, otherwise show the repository tests and source offline. If SQL is unavailable, do not weaken TLS, permissions, or identity settings.

### 2:00–3:15 — AI-assisted tool selection

```powershell
npm run agent -- "Show me all pending shipments"
```

**Say:** “Before contacting OpenAI, the agent starts the protected local MCP session and verifies the discovered contract. The model receives the original question and locally controlled strict function definitions—not discovery descriptions and not shipment data. Its output has no authority: the client parses it, requires zero or one allowlisted call, and validates the exact argument shape and value again. A valid call reuses the established MCP session; the SQL result is validated and formatted locally and is never fed back to the model.”

**Engineering concept:** A probabilistic component proposes intent; deterministic code owns authority, execution, and output. Unlike the direct CLI, the secure agent enforces the 64 KiB result-size limit, record-count limit, exact result shape and fields, and field-value constraints before local formatting. The model may legitimately select no tool or return another allowed outcome. Do not promise `get_shipments_by_status`, any rows, or any exact wording.

**Likely failure and fallback:** An expired key, provider outage, rate limit, unavailable model, invalid response, no-tool selection, launcher failure, or SQL failure is handled without exposing raw details. A no-tool selection is a valid allowed outcome. By default there is one model attempt; do not enable retries ad hoc. If the live call fails, explain the boundary using [`agent.ts`](../../clients/typescript/src/agent.ts), [`contracts.ts`](../../clients/typescript/src/contracts.ts), and the deterministic agent tests.

### 3:15–3:50 — Deterministic input rejection

```powershell
npm run dev -- status Delayed
```

**Say:** “`Delayed` is outside the local enum. The TypeScript CLI rejects it before launcher lookup, MCP startup, SQL, or OpenAI. This is deterministic argument validation in `parseCliArgs`; it is not an example of a model recognizing or rejecting an unsafe request. The server and agent also have their own independent validation boundaries.”

**Engineering concept:** Fail fast locally, constrain values with allowlists, and revalidate across trust boundaries. Expected output is a usage error naming the supported statuses, not shipment data.

**Likely failure and fallback:** If the command behaves differently, stop the live path because the checked implementation and runtime do not match. Show [`cli.ts`](../../clients/typescript/src/cli.ts) and its tests rather than improvising.

### 3:50–5:00 — Privacy boundary and legacy-enterprise proposal

**Say:** “The privacy boundary is deliberate: SQL-derived results stay local. The original user question crosses the provider boundary, so it needs data-classification and provider-policy review. Before model selection, the client validates the discovered MCP contract. After selection, it treats model output as untrusted and validates the call name, argument shape, and values before execution.

“For legacy .NET Framework, I propose an out-of-process .NET 10 MCP host, trusted identity propagation, and a narrow anti-corruption layer into the legacy application service. This is a proposed design, not an implemented integration; the legacy service would still own authorization and business rules.

“This demo is not production-ready. It needs enterprise identity and request-bound authorization, deployment and secret hardening, operational controls, and production-grade assurance. The application adds no MCP or SQL retry policy. Lower-level SqlClient connection resiliency may still apply depending on connection-string settings. Only eligible external model-selection failures can use the agent’s bounded optional retry.”

## Why these design choices

These are short answers for likely interview follow-ups.

- **Why MCP?** “It gives the tools a typed, discoverable protocol boundary independent of a particular model vendor. The same .NET tools can serve the deterministic client and the constrained agent, while tests can replace either side.”
- **Why stdio locally?** “The client owns one child process and its lifetime, there is no listening port, and protocol traffic stays on local pipes. For enterprise use I would choose an authenticated, versioned service boundary based on deployment requirements.”
- **Why no SQL-data feedback?** “The model is useful for intent selection, but a second summarization pass would expand disclosure and prompt-injection risk. Local code can validate and format the bounded result deterministically.”
- **Why validate discovery before selection?** “A compromised or incompatible server could advertise extra tools or altered schemas. Failing closed before the model sees a tool set prevents metadata or contract drift from expanding authority.”
- **Why validate arguments again?** “Strict schemas guide generation but do not confer trust. Model output is untrusted bytes, so code independently checks call count, name, JSON shape, integer bounds, enums, and additional properties.”
- **Why read-only plus least privilege?** “Read-only code prevents intended write paths; database authorization limits damage if the process or code path is compromised. Both are needed, and neither provides user-level authorization by itself.”
- **Why no MCP/SQL retry?** “The application adds no MCP or SQL retry policy. Lower-level SqlClient connection resiliency may still apply depending on connection-string settings. The agent’s bounded retry applies only to eligible external model-selection failures.”
- **Why out-of-process legacy integration?** “.NET Framework and .NET 10 have different runtime and dependency constraints. A service boundary avoids loading MCP concerns into the legacy process and supports versioning, isolation, gradual rollout, and rollback.”
- **What blocks production?** “The demo needs an approved threat model and data classification, trusted user/tenant identity, request-bound authorization, workload identity, verified least privilege, hardened secret and launcher deployment, validated TLS, audit and retention policy, rate limits and pagination, production-like contract/security/resilience tests, observability and SLOs, and controlled rollout and rollback ownership. Those are prerequisites, not backlog polish.”

## Failure handling without weakening controls

| Condition | Safe response during the interview |
| --- | --- |
| SQL Server missing or unhealthy | Stop live data commands. Use the offline runbook and fixed-query source walkthrough. Do not change permissions, disable encryption checks, seed ad hoc records, or target another database. |
| Protected launcher unavailable | Do not run the server directly as a substitute for the live path. Show source and mocked stdio tests; explain that launcher management is a separate deployment responsibility. |
| API credential expired/unavailable | Skip the live agent call. Use deterministic agent/model-router tests and explain expected categories. Never paste, print, or screen-share a replacement key. |
| API rate limit/provider outage | Treat the sanitized model failure as a valid operational outcome and switch offline. The optional second attempt is tightly bounded but should be configured and rehearsed beforehand, not enabled reactively. |
| Model selects no tool | Explain that zero calls are explicitly permitted and show the supported local no-tool message. Do not rerun until a preferred answer appears. |
| Shipment ID `1` not found | Describe correct not-found handling. Do not mutate data. If prevalidated, use the bounded list command only as a time-permitting alternative. |
| Unexpected CLI failure | Stop, preserve the sanitized screen, and use offline tests/source. Do not expose stderr from the server, environment variables, launcher internals, or raw exceptions. |
| Limited internet | Skip the OpenAI step. The deterministic client still needs local SQL/launcher; the fully offline presentation below needs only pre-restored dependencies and build artifacts. |

## Fully offline five-minute fallback

This presentation is deterministic and does not depend on an API key, SQL connection, protected launcher, live MCP server, or network access during the demonstration. While network access is available, restore the NuGet dependencies and install the npm packages successfully before disconnecting:

```powershell
Set-Location 'C:\Users\Ivan\source\repos\McpSqlDemo'
dotnet restore .\tests\McpSqlDemo.Tests\McpSqlDemo.Tests.csproj
Set-Location .\clients\typescript
npm ci --ignore-scripts
```

The demo commands then use restored NuGet packages and installed `node_modules`. Before presenting, clear live-only variables without printing them and suppress .NET workload update notifications and their background advertising-manifest downloads for this process:

```powershell
Set-Location 'C:\Users\Ivan\source\repos\McpSqlDemo'
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:MCP_SQL_CONNECTION -ErrorAction SilentlyContinue
Remove-Item Env:MCP_SERVER_LAUNCHER_PATH -ErrorAction SilentlyContinue
$env:MCP_AGENT_DIAGNOSTICS = '0'
$env:DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE = 'true'
```

`--no-restore` and the process-scoped workload setting remove known restore and workload-update dependencies; they do not by themselves prove absolute network isolation. If strict zero network traffic is required, verify it in the actual presentation environment.

### 0:00–0:45 — State the architecture and boundary

Use the opening script from the live presentation and show the [architecture overview](../../README.md#architecture-at-a-glance). Say explicitly that this fallback demonstrates code and isolation tests, not a user-facing offline agent mode. The deterministic mock router is a test double only; the repository does not provide an offline agent CLI.

### 0:45–1:45 — Run .NET unit tests

From the repository root:

```powershell
dotnet test .\tests\McpSqlDemo.Tests\McpSqlDemo.Tests.csproj --no-restore --filter "Category!=Integration"
```

Expected output is the test runner's pass/fail/skip summary, never live shipment rows. These tests use in-memory fakes and cover tool exposure, validation, bounded execution, cancellation, timeouts, and sanitized behavior without SQL or an MCP child process.

### 1:45–3:15 — Run TypeScript isolated tests

```powershell
Set-Location 'C:\Users\Ivan\source\repos\McpSqlDemo\clients\typescript'
npm test
```

Expected output is the TypeScript build followed by Node test results. This suite includes pure unit tests, deterministic model-router doubles, and MCP SDK client tests against [`mock-stdio-server.ts`](../../clients/typescript/test/mock-stdio-server.ts). The mock process exercises protocol behavior but is not the real .NET MCP server, protected launcher, or SQL database.

### 3:15–4:10 — Walk the deterministic boundaries

Open [`cli.ts`](../../clients/typescript/src/cli.ts), [`contracts.ts`](../../clients/typescript/src/contracts.ts), and [`agent.ts`](../../clients/typescript/src/agent.ts). Say: “CLI enums reject unsupported input locally. The agent requires the exact discovered inventory and schema, then parses and bounds the model-selected call independently. Tests inject a deterministic model router; that is dependency isolation, not an offline product mode.”

### 4:10–5:00 — Walk fixed SQL and enterprise proposal

Open [`ShipmentRepository.cs`](../../src/McpSqlDemo/ShipmentRepository.cs) and point to the three fixed `SELECT` statements, typed parameters, `TOP (20)`, and cancellation. Then show the [legacy blueprint](../architecture/legacy-integration-blueprint.md#proposed-target-architecture) and clearly label every authentication, identity, ACL, application-service, and rollout component as proposed and not implemented.

### Test classification

| Class | What it proves | Offline fallback |
| --- | --- | :---: |
| .NET unit/non-integration tests | Tool contract, local validation, fake-repository behavior, execution policy, and sanitized failures | Yes |
| TypeScript unit tests | CLI, contract, router parsing/reliability, observability, response validation, and agent orchestration with deterministic doubles | Yes |
| Mocked MCP SDK tests | Real SDK client/stdio protocol behavior against a local mock Node child process | Yes |
| SQL integration tests (`Category=Integration`) | Repository behavior and database/effective-permission checks against configured SQL | No; optional and intentionally excluded |
| Opt-in real MCP stdio integration test | Built .NET server plus real SQL over MCP stdio | No; optional and intentionally excluded |
| Live OpenAI agent check | Provider tool-selection behavior with the protected local path | No; manual and intentionally excluded |

## Source-to-claim map

- Command scripts and supported model: [`package.json`](../../clients/typescript/package.json) and [`openai-model-router.ts`](../../clients/typescript/src/openai-model-router.ts)
- CLI-before-launcher rejection: [`index.ts`](../../clients/typescript/src/index.ts), [`cli.ts`](../../clients/typescript/src/cli.ts), and [`client.ts`](../../clients/typescript/src/client.ts)
- Discovery, protected-launcher startup, and MCP calls: [`client.ts`](../../clients/typescript/src/client.ts) and [`agent-mcp.ts`](../../clients/typescript/src/agent-mcp.ts)
- Pre-model contract validation and post-model argument validation: [`contracts.ts`](../../clients/typescript/src/contracts.ts) and [`agent.ts`](../../clients/typescript/src/agent.ts)
- Model request shape and allowed outcomes: [`openai-model-router.ts`](../../clients/typescript/src/openai-model-router.ts)
- Fixed SQL and tool-level validation: [`ShipmentRepository.cs`](../../src/McpSqlDemo/ShipmentRepository.cs) and [`ShipmentTools.cs`](../../src/McpSqlDemo/ShipmentTools.cs)
- Offline CI and test boundaries: [CI workflow](../../.github/workflows/ci.yml), [.NET tests](../../tests/McpSqlDemo.Tests), and [TypeScript tests](../../clients/typescript/test)
- Privacy and enterprise distinctions: [trust boundaries](../architecture/trust-boundaries.md), [ADR-0001](../architecture/adr/0001-model-selection-without-data-feedback.md), and [legacy blueprint](../architecture/legacy-integration-blueprint.md)

## Post-demo cleanup

Close the terminal, then remove process-scoped live configuration without displaying values:

```powershell
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:MCP_MODEL_MAX_ATTEMPTS -ErrorAction SilentlyContinue
Remove-Item Env:MCP_AGENT_DIAGNOSTICS -ErrorAction SilentlyContinue
Remove-Item Env:MCP_SERVER_LAUNCHER_PATH -ErrorAction SilentlyContinue
```
