import assert from "node:assert/strict";
import test from "node:test";
import {
  autopilotContextFromHistory,
  lastTurnWasSystem,
  normalizeWorkerAutopilotPlan,
  workerAutopilotIdleStreak,
  workerAutopilotNextPrompt,
  workerAutopilotStepActivity,
  workerAutopilotSwapCarryNote,
} from "../src/workerAutopilot.js";

// 循環中遇到自動換腦的真實事件順序（brainSwapHook：公告→摘要回合→心法→換腦完成→已接手）
const SUMMARY = "交接摘要：".padEnd(260, "內容");
const swapHistory = [
  { type: "user_message", text: "把首頁改版做完", at: 1 },
  { type: "turn_end", resultText: "草稿完成", at: 2 },
  { type: "user_message", text: "🔁（自動循環）補上分類篩選列", autopilot: true, at: 3 },
  { type: "tool_call_start", name: "Edit", at: 4 },
  { type: "turn_end", resultText: "篩選列完成，改了 home.tsx", at: 5 },
  { type: "user_message", system: true, text: "🧠 context 已達 172k/200k，啟動自動換腦——先請 NPC 寫交接摘要", at: 6 },
  { type: "turn_end", resultText: SUMMARY, at: 7 },
  { type: "user_message", system: true, text: "🧠 換腦蒸餾出一條做事心法", at: 8 },
  { type: "user_message", system: true, text: "🧠 自動換腦完成：交接摘要已送進全新工作階段", at: 9 },
  { type: "turn_end", resultText: "已接手", at: 10 },
];

test("換腦後：教練看到的最新回合仍是換腦前的真實工作，且知道 NPC 是新 session", () => {
  const ctx = autopilotContextFromHistory(swapHistory);
  assert.equal(ctx.turns.at(-1)?.result, "篩選列完成，改了 home.tsx");
  assert.ok(ctx.turns.every((turn) => !/已接手/.test(turn.result ?? "")), "「已接手」不能被當成工作結果");
  assert.ok(ctx.carriedSummary?.startsWith("交接摘要"));
  assert.equal(ctx.freshSession, true);
});

test("換腦後又跑了一步真實工作：freshSession 回到 false", () => {
  const ctx = autopilotContextFromHistory([
    ...swapHistory,
    { type: "user_message", text: "🔁（自動循環）跑測試", autopilot: true, at: 11 },
    { type: "turn_end", resultText: "12/12 綠", at: 12 },
  ]);
  assert.equal(ctx.freshSession, false);
});

test("非換腦的系統回合（例如收尾交接）不算新 session", () => {
  const ctx = autopilotContextFromHistory([
    { type: "user_message", text: "做 X", at: 1 },
    { type: "turn_end", resultText: "ok", at: 2 },
    { type: "user_message", system: true, text: "🏁 自動循環在此結束，請只做一件事", at: 3 },
    { type: "turn_end", resultText: "收尾", at: 4 },
  ]);
  assert.equal(ctx.freshSession, false);
});

test("換腦的兩個系統回合不算空轉步：換腦前有產出的那步仍讓空轉連數歸零", () => {
  assert.equal(workerAutopilotIdleStreak(workerAutopilotStepActivity(swapHistory)), 0);
});

test("lastTurnWasSystem：換腦回合出錯時為 true、循環工作回合出錯時為 false", () => {
  assert.equal(lastTurnWasSystem(swapHistory), true);
  assert.equal(lastTurnWasSystem([...swapHistory, { type: "user_message", text: "🔁 下一步", autopilot: true }, { type: "user_message", notice: true, text: "通知" }]), false);
  assert.equal(lastTurnWasSystem([]), false);
});

test("swapCarryNote：循環開著時要求摘要保留目標、進度、下一步；沒目標就不加", () => {
  const plan = normalizeWorkerAutopilotPlan({ goal: "g", toTry: [{ text: "補 e2e 測試" }], blockers: ["等部署授權"] });
  const note = workerAutopilotSwapCarryNote("把首頁改版做完並上線", plan);
  assert.match(note, /把首頁改版做完並上線/);
  assert.match(note, /補 e2e 測試/);
  assert.match(note, /等部署授權/);
  assert.equal(workerAutopilotSwapCarryNote(null, plan), "");
});

test("prompt：freshSession 時要求指示自足、不把「已接手」當工作", () => {
  const base = {
    workerName: "w", role: null, workspaceLabel: "/x", turns: [], originalGoal: "g", carriedSummary: null,
    stepsRemaining: 3, proactive: true, retros: [], workspaceFacts: null, openRequests: [], plan: null,
    canExplore: false, explorationFindings: [], stallSignals: [],
  } as Parameters<typeof workerAutopilotNextPrompt>[0];
  assert.match(workerAutopilotNextPrompt({ ...base, freshSession: true }), /FRESH SESSION/);
  assert.doesNotMatch(workerAutopilotNextPrompt(base), /FRESH SESSION/);
});
