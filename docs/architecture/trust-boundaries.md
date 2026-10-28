# Trust Boundaries and Data Flow

## Scope and core privacy property

This document describes the implemented local demo and the boundaries introduced by the proposed legacy integration in [Legacy Enterprise Integration Blueprint](legacy-integration-blueprint.md). Proposed components are labeled explicitly.

In the current secure-agent path, the only user-originated/runtime data sent to the external AI model is the original question. The rest of the request content is locally controlled. Specifically, the model receives only:

1. the original user question;
2. locally controlled instructions; and
3. locally controlled definitions for the three trusted shipment tools.

The model never receives SQL-derived MCP tool results. The TypeScript agent invokes MCP only after validating model output, then validates and formats tool results locally. This limits data feedback; it does not make the model request privacy-free. The question itself may contain sensitive user-provided information. A real deployment requires an enterprise data-classification, minimization, retention, provider, residency, and acceptable-use policy before any question is sent externally.

## Boundary inventory

### 1. User question

The question is untrusted input, limited by the current agent to 1–2,000 characters. It may contain prompt injection, false identifiers, secrets, personal data, regulated data, or other sensitive content. Length validation is not data classification. The question must not be treated as trusted identity or authorization context.

### 2. External AI model

The model is outside the local trust boundary. It performs selection only and can return no call or a proposed call. Its output is untrusted. The current request uses `store: false`, but that option must not be described as guaranteeing zero provider-side processing or eliminating privacy, abuse-monitoring, legal, or operational considerations.

### 3. TypeScript secure agent

The agent is the local policy-enforcement orchestrator. It validates the question, discovers and validates the complete MCP contract, supplies fixed local model tool definitions, accepts at most one selected tool, validates exact arguments, enforces stage and overall deadlines, invokes at most one MCP tool, applies a 64 KiB post-receipt acceptance check, validates the exact shipment shape and values, and formats output locally. The check rejects an already received result before parsing or display; it does not cap transport buffering or memory consumed before validation.

### 3a. Proposed trusted authentication/session host — NOT IMPLEMENTED

An enterprise design requires a trusted authentication/session-host boundary before the TypeScript agent. That host would authenticate the user, resolve the authoritative tenant independently of the question, bind principal and tenant to a specific session/request, and pass protected identity context through an enterprise-defined channel. The current demo has no such host or identity channel; its unauthenticated local stdio process must not be treated as secure multi-user identity propagation.

### 4. Local tool contracts and validation

The current trusted set is exactly `list_shipments`, `get_shipment_by_id`, and `get_shipments_by_status`. Discovery fails if a tool is missing or extra, or an argument schema differs from the accepted structural shape. An explicitly supplied `additionalProperties` value must be `false`; omission is tolerated for the existing SDK-generated schema even though omission is permissive under JSON Schema semantics. Selected argument syntax is validated independently and rejects unknown arguments while enforcing local bounds/enums. Contract tests must retain this distinction. MCP discovery descriptions are not passed to the model. Additive tools or schema fields are not silently accepted.

### 5. MCP stdio transport

The TypeScript process communicates with the .NET 10 child process over local stdin/stdout using MCP. Standard output is protocol data. Server logs go to standard error. Process launch configuration, inherited environment, executable/script identity, and local account permissions are part of this boundary.

### 6. .NET MCP tools

The current tools revalidate bounded shipment IDs/statuses, declare read-only/non-destructive intent, apply concurrency and deadline policy, call `IShipmentRepository`, and map failures to known safe messages. Tool annotations support clients but are not an authorization control.

### 7. Proposed legacy application service

This component does not exist in the repository. It would be an approved out-of-process boundary owned by the enterprise application. It must authenticate the workload, validate the request-bound user/delegation and tenant context propagated from the proposed trusted host, authorize the query, enforce limits, and expose versioned read-only use cases.

### 8. Existing business rules and authorization

In the proposed design, these remain authoritative inside the enterprise application boundary. The model, agent, MCP process, and ACL must not recreate or bypass them. Tenant and row scope must derive from trusted identity and policy, never natural language or model arguments.

### 9. Database and SQL identity

The current demo repository executes fixed parameterized reads against a local SQL database with an externally configured identity. A production-like integration should normally keep the MCP process away from the enterprise database and let approved application data access own it. The effective SQL identity must be least privilege and independently verified.

### 10. Local result formatter

The current formatter accepts one exact shipment object for an ID lookup or at most 20 exact shipment objects for list queries. It rejects unknown fields, invalid types, unsafe/control text, invalid status, invalid quantity, excessive size, and unexpected MCP content. It produces a local tabular string; it does not call the model.

### 11. Sanitized diagnostics

Current agent diagnostics are disabled by default and, when enabled, emit allowlisted operational metadata such as stage, outcome, duration, counts, tool name, token usage, and a generated correlation ID. They exclude questions, prompts, arguments, payloads, shipment/SQL data, secrets, raw failures, and sensitive paths by construction. .NET logs use operation names, result counts, and failure categories rather than records or connection strings.

## Data-flow table

| Flow | Data crossing boundary | Trust treatment | Current protection | Enterprise requirement |
| --- | --- | --- | --- | --- |
| User → agent | Original question | Untrusted and potentially sensitive | Character bound | Classification, user notice, minimization, DLP/acceptable-use policy |
| Agent → external model | Question, fixed instructions, fixed tool definitions | Leaves local control | Tool definitions are local; `store: false`; bounded output | Provider/legal review, residency/retention decision; do not assume zero processing |
| Model → agent | Proposed zero/one tool call | Fully untrusted | Exact name/argument validation; at most one call | Maintain fail-closed policy and model allowlist |
| MCP server → agent during discovery | Tool names, descriptions, schemas | Local but untrusted until verified | Exact full-set and schema validation; discovered descriptions not sent to model | Signed/controlled deployment and contract tests |
| Agent ↔ MCP stdio | Validated call; MCP result/error | Cross-process boundary | Restricted launch environment, timeouts, cancellation, single call, post-receipt result acceptance limit | Process identity, binary/script integrity, host hardening; process/transport output and buffering limits |
| Proposed trusted host → agent/MCP — NOT IMPLEMENTED | Session-bound principal and tenant context, established separately from the question | Authentication and identity-ingress boundary | Not implemented; current local stdio is not a secure multi-user identity channel | Authenticate the principal, resolve tenant, bind context to the request/session, protect propagation, and reject missing/invalid/expired/mismatched/ambiguous context |
| MCP tool → current repository | Bounded query arguments | Revalidated | ID/status validation, deadline, concurrency limit | Keep narrow query-use-case interface |
| Current repository → demo DB | Fixed SQL and typed parameters | Database security boundary | Parameterization, timeouts, no write tool | Least privilege and effective-identity verification |
| MCP/ACL → proposed enterprise service | Query plus request-bound trusted identity/deadline metadata | Network/service boundary | Not implemented | Workload identity, token/context validation, session binding, user delegation, authorization, replay protection, versioning |
| Enterprise service → business rules | Authenticated query context | Internal authorization boundary | Not implemented here | Tenant/row/field policy and existing domain behavior |
| Business data → formatter | Minimal authorized shipment projection | Sensitive until classified | Size/shape/value validation; local formatting | Field minimization and output-handling policy |
| Components → diagnostics/audit | Operational metadata; security/audit events | Separate observability boundary | Sanitized local diagnostics | Define audit schema, access, retention, redaction, and tamper protection |

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Prompt injection asks for a new tool, policy change, SQL, or data exfiltration | Treat question as data; fixed local instructions and tool definitions; exact allowlist; validate model output; never expose arbitrary SQL |
| Model invents a tool, adds arguments, changes case/type, or emits multiple calls | Reject the selection; execute nothing |
| MCP server is replaced or exposes a changed/extra contract | Validate the complete discovered tool set and exact accepted schemas before model selection or execution; fail initialization |
| Tool result contains injection text, extra fields, control characters, excessive records, or oversized content | 64 KiB post-receipt acceptance check, exact object keys/types, safe text checks, status/value bounds, maximum 20 list records, local formatting only; proposed process/transport limits must bound pre-validation buffering and memory |
| User/model supplies another tenant or user ID | Never derive or override identity/scope from question or model-selected tool arguments; proposed trusted host binds authenticated context to the request, and the proposed service independently validates it and enforces tenant/row policy |
| Direct database shortcut bypasses business logic | Route proposed integration through the enterprise application service and existing authorization/domain paths |
| Overprivileged SQL identity enables writes or broad reads | Dedicated least-privilege identity, object/use-case-scoped permission, effective-permission tests, separation from administrator identities |
| Retry storm or duplicate work | One declared retry owner per hop; current retry is model-only; deadline-aware idempotent retries only; no retry on policy/validation failure |
| Raw exception or secret leaks through output/logs | Map to stable safe errors; allowlist diagnostic fields; exclude payloads, raw failures, connection strings, credentials, and paths |
| Local launcher/process substitution | Restrict filesystem/ACLs, validate deployment artifacts, minimize inherited environment, run under dedicated identity, monitor configuration changes |
| Question contains confidential or regulated data | Enterprise classification and policy before deployment; minimize/redact before provider call when approved; block disallowed classes |

## Fail-closed behavior

The current agent performs no tool call when initialization/contract validation fails, model output is malformed, the selected name or arguments are not exact, or the request is canceled/timed out before execution. It rejects malformed, oversized, or unexpected tool results instead of displaying them. No-tool model output returns a fixed local scope message.

The proposed identity path and enterprise service must deny when principal, tenant, token/context validation, session/request binding, workload identity, authorization evidence, contract version, or policy evaluation is missing, invalid, expired, mismatched, or ambiguous. The legacy application service must independently enforce authorization, tenant scope, row-level visibility, and field policy rather than trusting the agent or MCP decision. Unknown status mappings and partial responses fail closed. A diagnostics failure may remain best-effort, but it must never weaken authorization or validation. Protocol, token format and validation, session-binding mechanism, and workload-identity technology remain enterprise-specific choices.

## Availability limitation of the current response limit

The existing 64 KiB check is a post-receipt acceptance and validation limit applied to the returned text block. It prevents parsing or displaying an oversized accepted result, but the MCP SDK/stdio transport may already have buffered that result, so it does not bound bytes read or memory consumed before validation. A proposed enterprise design must add process-level or transport-level output, framing, buffering, and memory limits as availability controls. Those controls are not implemented by this demo's current size check.

## Logging and audit boundaries

Operational logs answer whether and where a request succeeded without recording business payloads. Security audit records answer who requested which approved use case, under which tenant/policy decision, and the outcome. These are different datasets with different access and retention requirements.

The proposed service should generate or accept a non-sensitive correlation ID, record authenticated principal identifiers in the protected audit system, record the use-case name and authorization decision, and avoid question text and shipment content unless a separately approved policy requires them. Never place tokens, credentials, connection strings, raw model/MCP payloads, database errors, or protected launcher content in either channel. Cross-boundary correlation and audit retention are enterprise decisions.

## Privacy limitations and non-goals

- Preventing SQL-derived results from reaching the model does not prevent the original question from containing sensitive data.
- `store: false` is a request setting, not a guarantee of zero provider-side data processing.
- This repository does not implement enterprise DLP, consent, residency, retention, legal hold, eDiscovery, or provider-contract controls.
- Sanitized diagnostics are not a complete security audit system.
- Read-only behavior reduces modification risk; it does not eliminate confidentiality, inference, availability, or authorization risk.
- Tool annotations and prompts are not security boundaries.
- This document does not certify compliance or production readiness.
