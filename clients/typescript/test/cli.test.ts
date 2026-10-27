import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliUsageError, parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("parses supported commands", () => {
    assert.deepEqual(parseCliArgs(["list"]), { kind: "list" });
    assert.deepEqual(parseCliArgs(["tools"]), { kind: "tools" });
    assert.deepEqual(parseCliArgs(["get", "1"]), { kind: "get", shipmentId: 1 });
    assert.deepEqual(parseCliArgs(["status", " pending "]), { kind: "status", status: "Pending" });
  });

  it("rejects missing, extra, and unknown arguments", () => {
    for (const args of [[], ["unknown"], ["list", "extra"], ["get"], ["status", "Pending", "extra"]]) {
      assert.throws(() => parseCliArgs(args), CliUsageError);
    }
  });

  it("rejects unsafe shipment IDs", () => {
    for (const value of ["0", "-1", "1.5", "01", "1000001", "1e2", "not-a-number"]) {
      assert.throws(() => parseCliArgs(["get", value]), CliUsageError);
    }
  });

  it("rejects statuses outside the server allowlist", () => {
    assert.throws(() => parseCliArgs(["status", "Delivered"]), CliUsageError);
  });
});
