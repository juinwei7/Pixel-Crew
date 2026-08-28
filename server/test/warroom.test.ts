import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWarroomResult,
  sanitizeCustomStances,
  warroomModels,
  warroomOpeningPrompt,
  warroomRebuttalPrompt,
  warroomStances,
  warroomSynthesisPrompt,
  WARROOM_STANCES,
} from "../src/warroom.js";

test("custom stances are sanitized, bounded to 2-4, and get a fallback brief", () => {
  assert.deepEqual(sanitizeCustomStances("not-an-array"), []);
  assert.deepEqual(sanitizeCustomStances([{ name: "只有一位" }]), []); // 1 位辯不起來
  const ok = sanitizeCustomStances([
    { name: "投資顧問", brief: "看報酬" },
    { name: "風控" },
    { name: "" },
    { name: "A" }, { name: "B" }, { name: "C" },
  ]);
  assert.equal(ok.length, 4); // 空名被濾掉、上限 4
  assert.equal(ok[0].name, "投資顧問");
  assert.match(ok[1].brief, /風控/); // 沒寫 brief 會補一個含角色名的中性立場
});

test("stance count scales with difficulty (2 simple / 3 medium / 4 hard incl. verifier)", () => {
  assert.equal(warroomStances("simple").length, 2);
  assert.equal(warroomStances("medium").length, 3);
  const hard = warroomStances("hard");
  assert.equal(hard.length, 4);
  assert.equal(hard[3].key, "verify");
});

test("difficulty tiers pick cheaper models for easy work, stronger for hard", () => {
  assert.deepEqual(warroomModels("simple"), { peer: "haiku", lead: "haiku" });
  assert.deepEqual(warroomModels("hard"), { peer: "sonnet", lead: "opus" });
  assert.equal(warroomModels("medium").lead, "sonnet");
});

test("three opposing stances exist so the debate is real, not unanimous", () => {
  const keys = WARROOM_STANCES.map((s) => s.key);
  assert.deepEqual(keys, ["propose", "challenge", "weigh"]);
  assert.match(WARROOM_STANCES[1].brief, /反對|魔鬼/);
});

test("prompts pin the debate contract (opening states, rebuttal challenges, synthesis is structured)", () => {
  assert.match(warroomOpeningPrompt({ topic: "要不要導入 CI", stanceBrief: "提案方" }), /鮮明表態/);
  assert.match(warroomRebuttalPrompt({ stanceBrief: "挑戰方", othersDebate: "別人說 A" }), /不同意誰/);
  const syn = warroomSynthesisPrompt({ topic: "x", debate: "d" });
  assert.match(syn, /<warroom_result>/);
  assert.match(syn, /最終裁決/);
});

test("parses a structured verdict with disputes and prioritized actions", () => {
  const result = parseWarroomResult(`<warroom_result>{
    "verdict":"先做地基再談視覺",
    "consensus":["不重寫 department.ts"],
    "disputes":[{"point":"孤兒清除","ruling":"採挑戰方：運行期巡檢為主"}],
    "actions":[{"priority":"P1","title":"warroom.ts 編排器","how":"Promise.allSettled"},{"priority":"P9","title":"次要","how":""}],
    "metrics":[{"label":"加權指數","value":"44,933","note":"+0.48%"},{"label":"","value":"沒label要被略過"}],
    "charts":[
      {"type":"line","title":"指數走勢","labels":["8/18","8/19","8/20"],"values":[45300,44719,44933],"unit":"點"},
      {"type":"donut","title":"單點圖要被略過","labels":["只有一點"],"values":[1]},
      {"type":"weird","title":"未知型別略過","labels":["a","b"],"values":[1,2]}
    ]
  }</warroom_result>`);
  assert.equal(result?.structured, true);
  assert.equal(result?.actions[0].priority, "P1");
  assert.equal(result?.actions[1].priority, "P2"); // 無效優先級回退到 P2
  assert.equal(result?.disputes[0].point, "孤兒清除");
  assert.equal(result?.metrics.length, 1); // 缺 label 的 metric 被過濾
  assert.equal(result?.metrics[0].value, "44,933");
  assert.equal(result?.charts.length, 1); // 單點圖與未知型別被過濾，只留合法的走勢圖
  assert.equal(result?.charts[0].type, "line");
  assert.deepEqual(result?.charts[0].values, [45300, 44719, 44933]);
});

test("falls back to plain-text verdict when unstructured, and redacts secrets", () => {
  const result = parseWarroomResult("token=sk-abcdefghijklmnopqrst 我覺得先做地基");
  assert.equal(result?.structured, false);
  assert.match(result?.verdict ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(result?.verdict ?? "", /sk-abcdefghijklmnopqrst/);
});
