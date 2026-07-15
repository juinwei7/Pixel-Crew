import assert from "node:assert/strict";
import test from "node:test";
import { applyRunnerEvent, emptyWorker } from "../src/workerState";

function startedWorker() {
  return applyRunnerEvent(
    emptyWorker("worker-1", "測試員", null, false, 0, "claude", "/repo"),
    { type: "user_message", text: "執行任務" },
  );
}

test("shows result and permission details on a failed turn", () => {
  const failed = applyRunnerEvent(startedWorker(), {
    type: "turn_end",
    resultText: "讀取設定失敗",
    costUsd: 0,
    durationMs: 25,
    isError: true,
    permissionDenials: [{ tool_name: "Read", reason: "路徑不在工作區" }],
  });

  const error = failed.turns[0].items.find((item) => item.kind === "system_error");
  assert.equal(failed.turns[0].status, "error");
  assert.match(error && "text" in error ? error.text : "", /讀取設定失敗/);
  assert.match(error && "text" in error ? error.text : "", /Read.*路徑不在工作區/);
});

test("shows an honest fallback when the CLI omits failure details", () => {
  const failed = applyRunnerEvent(startedWorker(), {
    type: "turn_end",
    resultText: "",
    costUsd: 0,
    durationMs: 25,
    isError: true,
    permissionDenials: [],
  });

  const error = failed.turns[0].items.find((item) => item.kind === "system_error");
  assert.match(error && "text" in error ? error.text : "", /CLI 沒有提供詳細原因/);
});
