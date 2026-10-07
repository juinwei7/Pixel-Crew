// 支柱 B「會探索的決策層」· gate-1 離線確定性測試（純函式層：動作解析、prompt 開關、findings 解析）。
// 真的上網查到真相這件事只有 gate-2 隔離沙盒能證，這裡證管路：explore 動作可被解析、prompt 在
// 預算內才提供 explore、findings 結構化回灌、解析失敗降級為 low 信心（不假裝查到）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP,
  parseWorkerAutopilotDecision,
  parseExplorationFindings,
  workerAutopilotExplorePrompt,
  workerAutopilotNextPrompt,
} from "../src/workerAutopilot.js";

// ── 解析 explore 動作 ──────────────────────────────────────────────────────
test("parseWorkerAutopilotDecision：explore 帶 query → explore 動作", () => {
  const text = `<worker_autopilot_next>{"action":"explore","query":"X 套件最新穩定版是幾？","reason":"版本決定寫法"}</worker_autopilot_next>`;
  const d = parseWorkerAutopilotDecision(text);
  assert.ok(d && d.action === "explore");
  assert.equal(d.query, "X 套件最新穩定版是幾？");
});

test("parseWorkerAutopilotDecision：explore 無 query → 退回安全 stop", () => {
  const text = `<worker_autopilot_next>{"action":"explore","reason":"想查點東西"}</worker_autopilot_next>`;
  const d = parseWorkerAutopilotDecision(text);
  assert.ok(d && d.action === "stop");
});

test("parseWorkerAutopilotDecision：explore 也能帶 planUpdate", () => {
  const text = `<worker_autopilot_next>{"action":"explore","query":"查A","reason":"r","plan":{"goal":"G","blockers":["不知道A"]}}</worker_autopilot_next>`;
  const d = parseWorkerAutopilotDecision(text);
  assert.ok(d && d.action === "explore");
  assert.ok(d.planUpdate && typeof d.planUpdate === "object");
});

// ── prompt：預算內才提供 explore、用盡則逼決定 ───────────────────────────────
test("workerAutopilotNextPrompt：canExplore 時提供 explore 動作與規則", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "W", role: null, workspaceLabel: "d:/t", turns: [], stepsRemaining: 3, proactive: true, canExplore: true,
  });
  assert.match(p, /EXPLORE BEFORE GUESSING/);
  assert.match(p, /"action":"explore"/);
});

test("workerAutopilotNextPrompt：!canExplore 時不提供 explore 動作", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "W", role: null, workspaceLabel: "d:/t", turns: [], stepsRemaining: 3, proactive: true, canExplore: false,
  });
  assert.doesNotMatch(p, /"action":"explore"/);
  assert.doesNotMatch(p, /EXPLORE BEFORE GUESSING/);
});

test("workerAutopilotNextPrompt：預算用盡且已有 findings → 注入結果並要求就地決定", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "W", role: null, workspaceLabel: "d:/t", turns: [], stepsRemaining: 3, proactive: true,
    canExplore: false,
    explorationFindings: [{ query: "X 版本？", summary: "最新穩定版 4.2", confidence: "high", sources: ["https://x.dev"] }],
  });
  assert.match(p, /Exploration done THIS step/);
  assert.match(p, /最新穩定版 4\.2/);
  assert.match(p, /high/);
  assert.match(p, /https:\/\/x\.dev/);
  assert.match(p, /EXPLORATION BUDGET FOR THIS STEP IS USED UP/);
});

test("workerAutopilotNextPrompt：findings 無出處時標記為低信心提示", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "W", role: null, workspaceLabel: "d:/t", turns: [], stepsRemaining: 3, proactive: true, canExplore: true,
    explorationFindings: [{ query: "q", summary: "s", confidence: "medium", sources: [] }],
  });
  assert.match(p, /none given — treat as low confidence/);
});

// ── 探索回合 prompt：唯讀約束 + 結構化回報 schema ───────────────────────────
test("workerAutopilotExplorePrompt：含查詢、唯讀約束、信心度/出處 schema", () => {
  const p = workerAutopilotExplorePrompt({ workerName: "W", workspaceLabel: "d:/t", query: "X 最新版？", originalGoal: "升級依賴" });
  assert.match(p, /X 最新版？/);
  assert.match(p, /read-only investigator/);
  assert.match(p, /must not write files/);
  assert.match(p, /<exploration_findings>/);
  assert.match(p, /"confidence":"high \| medium \| low"/);
});

// ── 探索回報解析：合規 → 結構化；壞/缺 → 降級 low 信心（不假裝查到）────────────
test("parseExplorationFindings：合規區塊 → 結構化", () => {
  const text = `blah <exploration_findings>{"summary":"是 4.2","confidence":"high","sources":["https://x.dev","package.json"]}</exploration_findings>`;
  const f = parseExplorationFindings(text, "X 版本？");
  assert.equal(f.query, "X 版本？");
  assert.equal(f.summary, "是 4.2");
  assert.equal(f.confidence, "high");
  assert.deepEqual(f.sources, ["https://x.dev", "package.json"]);
});

test("parseExplorationFindings：怪異 confidence → medium", () => {
  const text = `<exploration_findings>{"summary":"s","confidence":"超級確定","sources":[]}</exploration_findings>`;
  assert.equal(parseExplorationFindings(text, "q").confidence, "medium");
});

test("parseExplorationFindings：沒有合規區塊 → 降級 low 信心、不空摘要", () => {
  const f = parseExplorationFindings("模型只回了一段散文沒有標記區塊……", "q");
  assert.equal(f.confidence, "low");
  assert.deepEqual(f.sources, []);
  assert.ok(f.summary.length > 0);
});

test("MAX_EXPLORE_PER_STEP 是合理小正整數（花錢防呆）", () => {
  assert.ok(Number.isInteger(WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP));
  assert.ok(WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP >= 1 && WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP <= 4);
});
