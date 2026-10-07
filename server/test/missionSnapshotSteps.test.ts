import assert from "node:assert/strict";
import test from "node:test";

import { previewTerminalMissionSteps, SNAPSHOT_STEP_RESULT_MAX_CHARS, type DepartmentMissionStep } from "../src/mission.js";

function step(kind: DepartmentMissionStep["kind"], result: string | null): DepartmentMissionStep {
  return {
    id: `s-${kind}`, title: kind, objective: "", kind, assigneeWorkerId: "w1",
    acceptanceCriteria: [], status: "completed", attempt: 1, result, reviewResult: null,
    startedAt: null, completedAt: null,
  };
}

test("最終報告(synthesize)的 result 永遠保留完整（卡片要看的重點）", () => {
  const long = "報".repeat(SNAPSHOT_STEP_RESULT_MAX_CHARS + 500);
  const [out] = previewTerminalMissionSteps([step("synthesize", long)]);
  assert.equal(out.result, long, "synthesize 不可被截斷");
});

test("中間步驟過長的 result 截成預覽並標示省略字數", () => {
  const long = "x".repeat(SNAPSHOT_STEP_RESULT_MAX_CHARS + 123);
  const [out] = previewTerminalMissionSteps([step("execute", long)]);
  assert.ok(out.result!.length < long.length, "應被截短");
  assert.ok(out.result!.startsWith("x".repeat(SNAPSHOT_STEP_RESULT_MAX_CHARS)), "保留前段");
  assert.match(out.result!, /省略 123 字/, "標示省略字數");
});

test("中間步驟未超過上限則原封不動", () => {
  const shortText = "剛好不長";
  const [out] = previewTerminalMissionSteps([step("execute", shortText)]);
  assert.equal(out.result, shortText);
});

test("result 為 null 不會炸", () => {
  const [out] = previewTerminalMissionSteps([step("review", null)]);
  assert.equal(out.result, null);
});

test("不改動 reviewResult 等其他欄位（回傳仍是完整 step）", () => {
  const s = step("execute", "y".repeat(SNAPSHOT_STEP_RESULT_MAX_CHARS + 10));
  s.reviewResult = { verdict: "pass", summary: "ok", findings: [], risks: [], openQuestions: [], recommendedNextAction: null } as DepartmentMissionStep["reviewResult"];
  const [out] = previewTerminalMissionSteps([s]);
  assert.deepEqual(out.reviewResult, s.reviewResult, "reviewResult 結構不動");
  assert.equal(out.id, s.id);
  assert.equal(out.status, "completed");
});
