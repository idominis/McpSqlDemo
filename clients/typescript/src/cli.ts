export const USAGE = `Usage:
  npm run dev -- list
  npm run dev -- get <shipment-id>
  npm run dev -- status <Pending|Loading|Completed>
  npm run dev -- tools`;

export type CliCommand =
  | { readonly kind: "list" }
  | { readonly kind: "get"; readonly shipmentId: number }
  | { readonly kind: "status"; readonly status: ShipmentStatus }
  | { readonly kind: "tools" };

export type ShipmentStatus = "Pending" | "Loading" | "Completed";

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...values] = args;

  switch (command) {
    case "list":
    case "tools":
      requireArgumentCount(command, values, 0);
      return { kind: command };
    case "get": {
      requireArgumentCount(command, values, 1);
      const value = values[0] as string;
      if (!/^[1-9]\d*$/.test(value)) {
        throw new CliUsageError("Shipment ID must be a whole number between 1 and 1,000,000.");
      }
      const shipmentId = Number(value);
      if (!Number.isSafeInteger(shipmentId) || shipmentId > 1_000_000) {
        throw new CliUsageError("Shipment ID must be a whole number between 1 and 1,000,000.");
      }
      return { kind: "get", shipmentId };
    }
    case "status": {
      requireArgumentCount(command, values, 1);
      const status = normalizeStatus(values[0] as string);
      if (status === undefined) {
        throw new CliUsageError("Status must be one of: Pending, Loading, Completed.");
      }
      return { kind: "status", status };
    }
    default:
      throw new CliUsageError(command === undefined ? "A command is required." : "Unknown command.");
  }
}

function requireArgumentCount(command: string, values: readonly string[], count: number): void {
  if (values.length !== count) {
    throw new CliUsageError(`Invalid number of arguments for '${command}'.`);
  }
}

function normalizeStatus(value: string): ShipmentStatus | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "pending") return "Pending";
  if (normalized === "loading") return "Loading";
  if (normalized === "completed") return "Completed";
  return undefined;
}
