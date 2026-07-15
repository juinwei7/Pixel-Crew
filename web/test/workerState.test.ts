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

test("preserves the complete turn result when final text deltas are missing", () => {
  const completed = applyRunnerEvent(startedWorker(), {
    type: "turn_end",
    resultText: "完整的最終答覆",
    costUsd: 0,
    durationMs: 25,
    isError: false,
    permissionDenials: [],
  });

  const texts = completed.turns[0].items.filter((item) => item.kind === "assistant_text");
  assert.deepEqual(texts.map((item) => item.text), ["完整的最終答覆"]);
});

test("does not duplicate a final result already assembled from text deltas", () => {
  const streamed = applyRunnerEvent(startedWorker(), {
    type: "text_delta",
    text: "完整的最終答覆",
  });
  const completed = applyRunnerEvent(streamed, {
    type: "turn_end",
    resultText: "完整的最終答覆",
    costUsd: 0,
    durationMs: 25,
    isError: false,
    permissionDenials: [],
  });

  const texts = completed.turns[0].items.filter((item) => item.kind === "assistant_text");
  assert.equal(texts.length, 1);
});

test("resumes the same task when background Agent activity arrives after an intermediate turn end", () => {
  const waiting = applyRunnerEvent(startedWorker(), {
    type: "turn_end",
    resultText: "背景 Agent 執行中",
    costUsd: 0,
    durationMs: 25,
    isError: false,
    permissionDenials: [],
  });
  const resumed = applyRunnerEvent(waiting, {
    type: "tool_call_start",
    id: "verify-1",
    name: "Bash",
    input: { command: "npm test" },
  });
  assert.equal(resumed.turns.length, 1);
  assert.equal(resumed.turns[0].status, "running");
  assert.equal(resumed.busy, true);

  const withResult = applyRunnerEvent(resumed, {
    type: "text_delta",
    text: "完整審查結果",
  });
  const completed = applyRunnerEvent(withResult, {
    type: "turn_end",
    resultText: "完整審查結果",
    costUsd: 1,
    durationMs: 100,
    isError: false,
    permissionDenials: [],
  });
  const texts = completed.turns[0].items.filter((item) => item.kind === "assistant_text");
  assert.deepEqual(texts.map((item) => item.text), ["背景 Agent 執行中", "完整審查結果"]);
  assert.equal(completed.turns[0].status, "done");
});

test("keeps an async Agent visible until its parent turn ends", () => {
  const launched = applyRunnerEvent(startedWorker(), {
    type: "tool_call_start",
    id: "agent-1",
    name: "Agent",
    input: { description: "檢查規範", subagent_type: "general-purpose" },
  });
  assert.deepEqual(launched.subagents, [{
    id: "agent-1",
    name: "檢查規範",
    task: "檢查規範",
    background: false,
  }]);

  const background = applyRunnerEvent(launched, {
    type: "tool_call_result",
    id: "agent-1",
    output: [{ type: "text", text: "Async agent launched successfully.\nagentId: a123" }],
    isError: false,
  });
  assert.equal(background.subagents[0]?.background, true);

  const ended = applyRunnerEvent(background, {
    type: "turn_end",
    resultText: "完成",
    costUsd: 0,
    durationMs: 100,
    isError: false,
    permissionDenials: [],
  });
  assert.deepEqual(ended.subagents, []);
});

test("removes a foreground or failed Agent when its tool call returns", () => {
  const launch = (id: string) => applyRunnerEvent(startedWorker(), {
    type: "tool_call_start" as const,
    id,
    name: "Agent",
    input: { description: id },
  });

  const foreground = applyRunnerEvent(launch("foreground"), {
    type: "tool_call_result",
    id: "foreground",
    output: "完成檢查",
    isError: false,
  });
  assert.deepEqual(foreground.subagents, []);

  const failed = applyRunnerEvent(launch("failed"), {
    type: "tool_call_result",
    id: "failed",
    output: "啟動失敗",
    isError: true,
  });
  assert.deepEqual(failed.subagents, []);
});
