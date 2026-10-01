// Stage 4 自找問題測試：驗真閘門(重現+證據才動)、挑下一個(只挑驗真、依嚴重度)、正規化去重。
// 這是 owner 定的「先驗真才動、不在幻覺問題空轉」的程式化。
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFoundProblems,
  shouldActOnProblem,
  pickNextProblem,
  problemToGoal,
  type FoundProblem,
} from "../src/selfEvolveProblems.js";

const mk = (o: Partial<FoundProblem>): FoundProblem => ({
  id: "p", title: "t", area: "a", hypothesis: "h", reproduced: true, evidence: "測試X失敗", severity: "medium", ...o,
});

test("驗真閘門：未重現 → 不動", () => {
  assert.equal(shouldActOnProblem(mk({ reproduced: false })).act, false);
});

test("驗真閘門：重現了但沒證據 → 不動", () => {
  assert.equal(shouldActOnProblem(mk({ reproduced: true, evidence: "" })).act, false);
});

test("驗真閘門：重現＋有證據 → 可動", () => {
  assert.equal(shouldActOnProblem(mk({})).act, true);
});

test("挑下一個：只挑通過驗真的，依嚴重度 high→low", () => {
  const problems = [
    mk({ id: "a", severity: "low", reproduced: true, evidence: "e" }),
    mk({ id: "b", severity: "high", reproduced: true, evidence: "e" }),
    mk({ id: "c", severity: "high", reproduced: false }), // 未驗真，不選
  ];
  const picked = pickNextProblem(problems);
  assert.equal(picked?.id, "b"); // high 且驗真
});

test("挑下一個：全未驗真 → null（不自找事做）", () => {
  const problems = [mk({ reproduced: false }), mk({ reproduced: true, evidence: "" })];
  assert.equal(pickNextProblem(problems), null);
});

test("normalize：缺 title 丟棄、同標題去重、clamp 嚴重度、reproduced 僅 true 才算", () => {
  const list = normalizeFoundProblems([
    { title: "" },
    { title: "Bug A", severity: "超嚴重", reproduced: "yes" },
    { title: "Bug A", severity: "high" }, // 重複標題
    { title: "Bug B", reproduced: true },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "Bug A");
  assert.equal(list[0].severity, "medium"); // 怪異值 clamp
  assert.equal(list[0].reproduced, false);  // "yes" 非 true
  assert.equal(list[1].reproduced, true);
});

test("problemToGoal：含先寫失敗測試再修、不得弱化既有測試", () => {
  const g = problemToGoal(mk({ title: "X 崩潰", area: "foo.ts" }));
  assert.match(g, /X 崩潰/);
  assert.match(g, /會失敗的測試/);
  assert.match(g, /不得弱化既有測試/);
});
