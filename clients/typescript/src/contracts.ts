import type { ModelToolDefinition } from "./model-router.js";

export const SHIPMENT_STATUSES = ["Pending", "Loading", "Completed"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export type TrustedToolName = "list_shipments" | "get_shipment_by_id" | "get_shipments_by_status";

export interface DiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export const TRUSTED_MODEL_TOOLS: readonly ModelToolDefinition[] = [
  {
    name: "list_shipments",
    description: "List up to 20 demo shipments. Use when no shipment ID or status filter is requested.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_shipment_by_id",
    description: "Get one demo shipment by its numeric shipment ID.",
    parameters: {
      type: "object",
      properties: {
        shipmentId: { type: "integer", minimum: 1, maximum: 1_000_000 },
      },
      required: ["shipmentId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_shipments_by_status",
    description: "List up to 20 demo shipments having exactly one supported shipment status.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: SHIPMENT_STATUSES },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
];

const EXPECTED_PARAMETERS: Readonly<Record<TrustedToolName, Readonly<Record<string, "integer" | "string">>>> = {
  list_shipments: {},
  get_shipment_by_id: { shipmentId: "integer" },
  get_shipments_by_status: { status: "string" },
};

const ALLOWED_SCHEMA_METADATA = new Set(["$schema", "title", "description"]);

export class ToolContractError extends Error {
  public constructor() {
    super("The MCP server's tool contract did not match the trusted shipment-tool contract.");
    this.name = "ToolContractError";
  }
}

export function validateDiscoveredTools(tools: readonly DiscoveredTool[]): void {
  const expectedNames = Object.keys(EXPECTED_PARAMETERS).sort();
  const actualNames = tools.map((tool) => tool.name).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new ToolContractError();
  }

  for (const tool of tools) {
    if (!isTrustedToolName(tool.name)) throw new ToolContractError();
    validateInputSchema(tool.inputSchema, EXPECTED_PARAMETERS[tool.name]);
  }
}

function validateInputSchema(schema: unknown, expected: Readonly<Record<string, "integer" | "string">>): void {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) throw new ToolContractError();
  const allowedTopLevel = new Set(["type", "properties", "required", "additionalProperties", ...ALLOWED_SCHEMA_METADATA]);
  if (Object.keys(schema).some((key) => !allowedTopLevel.has(key))) throw new ToolContractError();
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new ToolContractError();

  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(schema.properties).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new ToolContractError();
  }

  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((value) => typeof value !== "string")) throw new ToolContractError();
  const requiredNames = [...required].sort();
  if (requiredNames.length !== expectedNames.length || requiredNames.some((name, index) => name !== expectedNames[index])) {
    throw new ToolContractError();
  }

  for (const name of expectedNames) {
    const property = schema.properties[name];
    if (!isRecord(property) || property.type !== expected[name]) throw new ToolContractError();
    const allowedPropertyKeys = new Set(["type", ...ALLOWED_SCHEMA_METADATA]);
    if (Object.keys(property).some((key) => !allowedPropertyKeys.has(key))) throw new ToolContractError();
  }
}

export function isTrustedToolName(value: string): value is TrustedToolName {
  return Object.prototype.hasOwnProperty.call(EXPECTED_PARAMETERS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
