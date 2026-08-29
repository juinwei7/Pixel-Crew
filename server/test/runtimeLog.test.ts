import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRuntimeLog, runtimeLogPath } from "../src/runtimeLog.js";

test("runtime log records a one-line lifecycle event and redacts bearer values", () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-runtime-log-"));
  try {
    appendRuntimeLog(directory, "HTTP listener error", "Bearer secret-token\nsecond line");
    const content = readFileSync(runtimeLogPath(directory), "utf8");
    assert.match(content, /HTTP listener error \| Bearer \[redacted\] second line/);
    assert.doesNotMatch(content, /secret-token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
