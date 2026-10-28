# MCP Contract Versioning Policy

## Scope

This policy proposes how independently deployed TypeScript clients and .NET MCP servers should evolve the shipment tool contract. It preserves the current fail-closed behavior: the client requires the exact fixed tool allowlist and accepted argument schemas. The policy does not loosen discovery validation or allow arbitrary capability adoption.

## Current contract baseline

The current client trusts exactly these names:

- `list_shipments` with no arguments;
- `get_shipment_by_id` with one required integer `shipmentId`;
- `get_shipments_by_status` with one required string `status`.

At discovery, the complete set must match. Accepted schemas must have the expected object/property/required structure; unknown tools, properties, schema keywords outside the accepted metadata, or an explicitly supplied `additionalProperties` value other than `false` fail validation. The validator also accepts an omitted `additionalProperties`. Under JSON Schema semantics that omission is permissive, but the current discovery validator tolerates it for the existing SDK-generated schema. This does not make selected calls permissive: independent selected-call validation accepts only the exact argument object for the chosen tool and rejects unknown arguments while also enforcing local numeric bounds and status values. Contract tests must preserve this deliberate distinction between tolerated discovery-schema omission and strict call validation. Selected calls and returned shipment data are validated again. These checks remain mandatory and must not be made permissive during version migration.

## Version model

Treat a complete allowlisted tool set, its argument schemas, result schemas, safe error categories, and documented semantics as one **contract profile**. Give each profile an immutable identifier such as `shipment-query/v1`. The identifier is proposed metadata for deployment and negotiation; it does not exist in the current repository.

Do not reinterpret an existing profile. Any semantic or structural change creates a new reviewed profile and corresponding local validation code. Pin each released client to an explicit set of profile implementations, normally one active profile plus a time-bounded previous profile during migration.

## Compatibility classification

### Breaking changes

For this exact-contract client, the following are breaking and require a new profile and coordinated migration:

- Adding, removing, or renaming a tool.
- Adding, removing, renaming, retyping, or changing requiredness of an argument.
- Expanding or narrowing an enum, numeric bound, record limit, text limit, or result shape.
- Adding a result field, changing nullability, precision, ordering guarantees, or not-found behavior.
- Changing authorization, tenant scope, consistency, pagination, timeout, or error semantics.
- Changing a tool from read-only to mutating or adding any side effect.

Although some changes are often called additive in general API versioning, adding a tool or optional schema field is intentionally breaking for the current full-set/exact-schema allowlist. The client must never accept it merely because an MCP server advertises it.

### Additive non-contract changes

Changes are non-breaking only when they do not alter validated wire shape or documented behavior, for example internal refactoring, performance improvement within existing deadlines, additional internal tests, or sanitized operational metrics. Description-only edits should still receive review because descriptions can influence operators or other clients, even though the current secure agent sends its own local descriptions to the model.

## Independent deployment strategy

Client and server deployments must be independently reversible:

1. Implement the new profile at a separately named/versioned endpoint or process while retaining the old endpoint or process.
2. Release client code that contains explicit validators and local model definitions for the new profile but keep routing disabled.
3. Run contract tests against both supported client/server pairs.
4. Enable the new pair for a small cohort through deployment configuration, never by trusting arbitrary discovery output.
5. Expand after compatibility, security, and operational gates pass.
6. Retire the old profile only after its published support window and rollback window end.

An old client connecting to a new-only server, or a new-only client connecting to an old server, must fail initialization safely rather than partially operate.

## Safe capability negotiation

Discovery is evidence to validate, not authority to grant capability. A client may choose among profiles only when all of the following hold:

- The profile identifier is locally allowlisted and bound to compiled/local tool definitions and validators.
- The discovered tool set and schemas exactly match that profile.
- The server/deployment identity is trusted by the local launch or approved service configuration.
- The profile is enabled by operator-controlled configuration for that environment.

Do not select the highest server-advertised version automatically. Do not merge tools from profiles. Do not use descriptions, model output, or a server-supplied schema to generate new permissions at runtime. If negotiation is absent, ambiguous, malformed, or unsupported, execute no tool.

The current client expects one exact tool set. For the existing stdio architecture, concurrent old and new profiles therefore require separately named endpoints or processes, each advertising only its own inventory; one discovery response must not advertise both inventories. Same-endpoint profile negotiation is a future capability that requires a separate design and implementation. Until then, the practical safe behavior is unchanged: connect to the configured process and validate the one compiled-in baseline profile exactly.

## Backward compatibility and deprecation

Maintain backward compatibility through parallel, immutable profiles rather than permissive parsing. Publish for each profile:

- introduction date, owner, and supported client/server versions;
- exact tools, argument/result schemas, semantics, limits, and safe errors;
- security and authorization expectations;
- deprecation date, migration guide, and removal date.

Deprecation must be observable without changing tool results or leaking payloads. Inventory active profile use through sanitized metrics, notify owners, and prove that supported consumers have migrated. Never weaken validation temporarily to bridge a migration.

## Contract-test requirements

Every supported profile requires automated tests that verify:

- Exact tool names and tool count; no missing or extra tools.
- Exact argument types, required fields, bounds, enums, and `additionalProperties` behavior.
- Rejection of unknown schema keywords except explicitly accepted metadata.
- Exact selected-call validation, including zero/multiple calls, unknown names, reordered/extra/missing arguments, type/range violations, and oversized model output.
- Exact result fields/types, record and byte limits, text safety, precision, statuses, and error mapping.
- Read-only semantics and absence of arbitrary SQL or mutation capabilities.
- Old client ↔ old server and new client ↔ new server success during migration.
- Old client ↔ incompatible new server and new client ↔ incompatible old server fail-closed behavior.
- Cancellation, deadline, shutdown, and sanitized diagnostic behavior.

Contract fixtures must use synthetic data and must not contain credentials, connection strings, real company/customer information, or protected launcher material.

## Migration example

If a future requirement adds pagination, do not add optional `cursor` or `pageSize` fields to `list_shipments` under the current profile. Define a new profile with a new explicitly allowlisted tool/shape, implement its validator and bounded result type, deploy it alongside v1, and migrate clients behind a controlled flag. The model sees only the locally defined profile enabled for that client.

## Rollback

Before rollout, retain the previous client artifact, server artifact/profile, and deployment configuration. On elevated contract rejection, validation error, authorization error, latency, or unexpected result:

1. Stop expanding traffic.
2. Disable the new profile route or feature flag.
3. Restore the previous matched client/server pair.
4. Confirm that fail-closed mismatched clients are not repeatedly retrying.
5. Review sanitized correlation data and contract-test gaps; do not capture sensitive payloads as a shortcut.

Because the documented tools are read-only, application data compensation is not expected. Operational rollback still requires verification of child processes, active sessions, audit continuity, and version routing.

## Ownership decisions

A real enterprise must assign contract ownership, approval authority, support/deprecation windows, profile registry location, artifact identity mechanism, rollout gates, and emergency rollback authority. Until then, the current exact allowlist and validation behavior is the only supported profile in this repository.
