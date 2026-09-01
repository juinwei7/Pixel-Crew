import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalDiagnostics } from "../src/diagnostics.js";

test("local diagnostics aggregate only operational counts and redact mission content", () => {
  const result = buildLocalDiagnostics([
    { id: "1", status: "completed" },
    { id: "2", status: "failed", error: "runner timed out" },
  ] as never, [
    { kind: "websocket_reconnect", value: 1, createdAt: "2026-09-01T00:00:00.000Z" },
    { kind: "fps_sample", value: 48, createdAt: "2026-09-01T00:00:00.000Z" },
    { kind: "fps_sample", value: 52, createdAt: "2026-09-01T00:00:00.000Z" },
    { kind: "approval_wait", value: 14, createdAt: "2026-09-01T00:00:00.000Z" },
  ]);
  assert.equal(result.missions.successRate, 50);
  assert.deepEqual(result.missions.failuresByReason, [{ reason: "runner timed out", count: 1 }]);
  assert.equal(result.responsiveness.medianFps, 50);
  assert.equal(result.responsiveness.fpsBand, "good");
  assert.equal(result.responsiveness.medianApprovalWaitSeconds, 14);
  assert.match(result.privacy, /No prompts/);
});
