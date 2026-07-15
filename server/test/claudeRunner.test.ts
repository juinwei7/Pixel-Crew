import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvalBridgeLaunch } from "../src/claudeRunner.js";

test("approval MCP bridge starts outside the Pixel Crew working directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pixel-crew-approval-cwd-"));
  try {
    const { args } = approvalBridgeLaunch();
    assert.match(args[1] ?? "", /^file:\/\//);
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const result = spawnSync(process.execPath, args, {
      cwd,
      input: `${message}\n`,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.result.tools[0].name, "approval_prompt");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
