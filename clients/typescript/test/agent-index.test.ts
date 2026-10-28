import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

describe("agent CLI failure contract", () => {
  it("keeps the sanitized usage message and failure exit code", () => {
    const entryPoint = fileURLToPath(new URL("../src/agent-index.js", import.meta.url));
    const result = spawnSync(process.execPath, [entryPoint], { encoding: "utf8", env: {} });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "The question must contain between 1 and 2,000 characters.");
  });
});
