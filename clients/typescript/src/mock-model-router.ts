import type { ModelRouter, ModelSelection, ModelToolDefinition } from "./model-router.js";

/** Deterministic, network-free router for tests and local security verification. */
export class DeterministicMockModelRouter implements ModelRouter {
  public async selectTool(
    question: string,
    _tools: readonly ModelToolDefinition[],
    _signal: AbortSignal,
  ): Promise<ModelSelection> {
    const id = /\b(?:id\s*)?#?(\d{1,7})\b/i.exec(question)?.[1];
    if (id !== undefined) {
      return { kind: "tool_calls", calls: [{ name: "get_shipment_by_id", arguments: JSON.stringify({ shipmentId: Number(id) }) }] };
    }
    const status = /\b(pending|loading|completed)\b/i.exec(question)?.[1];
    if (status !== undefined) {
      const canonical = `${status[0]?.toUpperCase()}${status.slice(1).toLowerCase()}`;
      return { kind: "tool_calls", calls: [{ name: "get_shipments_by_status", arguments: JSON.stringify({ status: canonical }) }] };
    }
    if (/\b(list|all|shipments)\b/i.test(question)) {
      return { kind: "tool_calls", calls: [{ name: "list_shipments", arguments: "{}" }] };
    }
    return { kind: "none" };
  }
}
