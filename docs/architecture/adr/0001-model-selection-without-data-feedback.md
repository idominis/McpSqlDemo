# ADR-0001: Model Selection Without Data Feedback

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The secure TypeScript agent uses an external AI model to interpret a natural-language shipment question. Sending database-derived results back to that model would expand the external data boundary, increase prompt-injection and data-disclosure risk, complicate classification and retention analysis, and make output correctness depend on another probabilistic pass.

The local application can perform the remaining work deterministically. It owns a fixed shipment-tool allowlist and local function definitions, validates MCP discovery and model selection, executes at most one read-only tool, validates the bounded result, and formats the response.

The original user question still crosses the provider boundary and may itself contain sensitive information. The OpenAI request currently sets `store: false`; that setting must not be interpreted as guaranteeing zero provider-side data processing or eliminating privacy, security, legal, abuse-monitoring, residency, or retention considerations.

## Decision

The AI model performs tool selection only.

The model receives the original user question, locally controlled instructions, and locally controlled tool definitions. It may return no tool call or one proposed tool call. The local agent treats that output as untrusted and validates it against the exact allowlist and argument rules before execution.

SQL/MCP results are validated and formatted locally and are never sent back to the AI provider. No second model call summarizes, rewrites, ranks, or explains the result. A no-tool outcome uses a fixed local message.

## Alternatives considered

### Send tool results to the model for a natural-language answer

Rejected. This would disclose locally retrieved data to the provider, expose untrusted result text to another model pass, and make the data boundary and output less deterministic. It could be reconsidered only through a new architecture decision with approved classification and controls.

### Use the model to generate SQL

Rejected. Generated SQL would create an unnecessarily broad capability and risk bypassing fixed query, authorization, result-bound, and least-privilege controls.

### Use deterministic parsing only, with no model

Viable for a smaller command grammar and potentially preferable in higher-sensitivity deployments. It was not selected for this portfolio path because the exercise demonstrates constrained natural-language tool selection. It remains a deployment alternative where questions cannot leave the local boundary.

### Run a locally hosted model

Potentially reduces the external-provider boundary but adds model hosting, patching, capacity, isolation, and evaluation responsibilities. It does not remove the need to validate tool selection or protect questions/results. This repository does not implement it.

### Return raw MCP JSON directly

Rejected for the secure agent. Local validation and stable formatting enforce byte, record, field, value, and control-character constraints before display.

## Positive consequences

- SQL-derived shipment data remains within the local execution path.
- The external model cannot observe tool results and cannot request follow-up tools based on them.
- At most one locally validated MCP tool executes per question.
- Result validation and formatting are deterministic, testable, bounded, and independent of provider availability after selection.
- Prompt injection embedded in a database text field is not fed back to the model.
- Provider token usage and latency are bounded to the selection stage.

## Tradeoffs and limitations

- Output is a fixed local table rather than a conversational synthesis.
- The model cannot compare, aggregate, explain, or ask follow-up questions about returned records.
- Natural-language selection can still be incorrect, return no tool, or fail; local validation prevents unauthorized shape but not every semantic misclassification.
- The original question crosses the external boundary and may disclose sensitive user-provided information.
- `store: false` does not resolve all provider-side privacy or processing considerations.
- Local formatting and validation code must evolve explicitly with every supported contract profile.
- This decision does not itself provide enterprise authentication, tenant isolation, row authorization, data classification, or compliance.

## Security implications

Model output has no authority by itself. Exact local tool/schema allowlisting, selected-call validation, at-most-one execution, bounded deadlines, result size/shape/value validation, safe error mapping, least-privilege data access, and sanitized diagnostics remain required.

The user question is untrusted both as a prompt-injection source and as a possible container for confidential, personal, regulated, or credential data. Before real-world deployment, enterprise policy must determine whether questions may be sent to an external model and what minimization, blocking, notice, provider, residency, and retention controls apply.

Tool results must not leak indirectly through diagnostics, exception text, traces, metrics dimensions, model retries, or support captures. Authentication and authorization must be enforced by trusted local/enterprise components, never inferred from question text or model arguments.

## Circumstances requiring a new architecture decision

A new ADR is required before any of the following:

- Sending MCP, SQL, legacy-service, or other retrieved results to an AI provider.
- Adding a second model call for summarization, explanation, ranking, or response generation.
- Allowing multiple, parallel, chained, or model-directed follow-up tool calls.
- Allowing model-generated SQL, arbitrary filters, writes, or side-effecting tools.
- Changing from an external model to a local/self-hosted model as a security boundary decision.
- Introducing retrieval, conversation memory, caching, telemetry, evaluation, or support capture that contains questions or tool results.
- Expanding to data classifications, tenants, jurisdictions, or provider terms not covered by the approved policy.
- Moving validation or authorization responsibility into the model or prompt.

Any replacement decision must document data flows, classification, provider processing assumptions, authorization, validation, logging, retention, threat model, tests, rollout, and rollback.
