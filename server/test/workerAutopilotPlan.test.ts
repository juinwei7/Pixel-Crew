// 支柱 A「活的計畫」增量 1 · gate-1 離線確定性測試。
// 重點不是「能存計畫」，而是用新舊護欄對照，證明新機制抓得到舊機制漏掉的長程繞圈——
// 這是把「沒碰到所以安全」換成「跑給你看它真的變好」的第一關。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKER_AUTOPILOT_PLAN_LIMITS,
  isWorkerAutopilotPlanEmpty,
  mergeWorkerAutopilotPlan,
  normalizeWorkerAutopilotPlan,
  parseWorkerAutopilotDecision,
  seedWorkerAutopilotPlan,
  workerAutopilotNextPrompt,
  workerAutopilotPlanBlock,
  workerAutopilotPlanProgressGuard,
  workerAutopilotProgressGuard,
  WorkerAutopilotPlanStore,
  type WorkerAutopilotDecision,
  type WorkerAutopilotPlan,
  type WorkerAutopilotTurn,
} from "../src/workerAutopilot.js";

// ── 正規化（可序列化、可 diff、壞輸入不崩）──────────────────────────────────
test("normalizeWorkerAutopilotPlan：壞輸入回空計畫、好輸入逐欄保留", () => {
  assert.deepEqual(normalizeWorkerAutopilotPlan(null), {
    goal: "", hypotheses: [], tried: [], toTry: [], blockers: [], updatedRound: 0,
  });
  assert.deepEqual(normalizeWorkerAutopilotPlan("garbage").tried, []);
  const plan = normalizeWorkerAutopilotPlan({
    goal: "把自動循環變成會思考的第二個大腦",
    hypotheses: ["決策層瞎是根因"],
    tried: [{ text: "只改 prompt 加換角度", outcome: "治標、仍貪心單步" }],
    toTry: [{ text: "加活的計畫狀態", need: "讀碼" }],
    blockers: ["決策層不能查證"],
    updatedRound: 3,
  });
  assert.equal(plan.goal, "把自動循環變成會思考的第二個大腦");
  assert.deepEqual(plan.hypotheses, ["決策層瞎是根因"]);
  assert.equal(plan.tried[0].outcome, "治標、仍貪心單步");
  assert.equal(plan.toTry[0].need, "讀碼");
  assert.equal(plan.updatedRound, 3);
});

test("normalizeWorkerAutopilotPlan：超量截斷＋去重", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ text: `step ${i}`, outcome: "x" }));
  const plan = normalizeWorkerAutopilotPlan({ tried: [...many, { text: "step 0", outcome: "dup" }] });
  assert.equal(plan.tried.length, WORKER_AUTOPILOT_PLAN_LIMITS.tried.count);
  // 去重：step 0 只出現一次
  assert.equal(plan.tried.filter((t) => t.text === "step 0").length, 1);
});

test("isWorkerAutopilotPlanEmpty：全空為真、有任一欄為假", () => {
  assert.equal(isWorkerAutopilotPlanEmpty(normalizeWorkerAutopilotPlan(null)), true);
  assert.equal(isWorkerAutopilotPlanEmpty(normalizeWorkerAutopilotPlan({ goal: "x" })), false);
});

// ── 種入＝吃掉既有 goal/retro，不另開並存狀態（單一事實來源）──────────────────
test("seedWorkerAutopilotPlan：goal→根錨、retros→已試（新的在前、去重）", () => {
  const plan = seedWorkerAutopilotPlan("大局目標", ["教訓A", "教訓B", "教訓A"]);
  assert.equal(plan.goal, "大局目標");
  assert.deepEqual(plan.tried.map((t) => t.text), ["教訓A", "教訓B"]);
  assert.equal(plan.tried.every((t) => t.outcome === ""), true);
});

// ── 套用模型回傳的更新：根錨防漂移、updatedRound 單調、changed 旗標 ──────────
test("mergeWorkerAutopilotPlan：模型漏填 goal 時保留舊根錨、round 單調遞增", () => {
  const prev = seedWorkerAutopilotPlan("原始目標", []);
  const { plan, changed } = mergeWorkerAutopilotPlan(prev, { tried: [{ text: "試了X", outcome: "不行" }] }, 2);
  assert.equal(plan.goal, "原始目標"); // 根錨未被改空
  assert.equal(plan.updatedRound, 2);
  assert.equal(changed, true);
});

test("mergeWorkerAutopilotPlan：內容相同時 changed=false、round 不倒退", () => {
  const prev = normalizeWorkerAutopilotPlan({ goal: "G", tried: [{ text: "a", outcome: "b" }], updatedRound: 5 });
  const { plan, changed } = mergeWorkerAutopilotPlan(prev, { goal: "G", tried: [{ text: "a", outcome: "b" }] }, 3);
  assert.equal(changed, false);
  assert.equal(plan.updatedRound, 5); // 不因傳入較小 round 而倒退
});

// ── prompt 區塊渲染 ────────────────────────────────────────────────────────
test("workerAutopilotPlanBlock：空計畫回空字串、有內容含單一事實來源與 Tried 全記憶語", () => {
  assert.equal(workerAutopilotPlanBlock(normalizeWorkerAutopilotPlan(null)), "");
  const block = workerAutopilotPlanBlock(normalizeWorkerAutopilotPlan({
    goal: "G", tried: [{ text: "試X", outcome: "撞牆" }], toTry: [{ text: "換角度Y", need: "上網" }],
  }));
  assert.match(block, /single evolving source of truth/);
  assert.match(block, /complete long-range memory/);
  assert.match(block, /試X → 撞牆/);
  assert.match(block, /換角度Y \[needs: 上網\]/);
});

// ── gate-1 核心：新舊護欄對照，證明新機制抓得到長程繞圈 ──────────────────────
test("gate-1：長程繞圈——舊護欄(只看近3回合)漏抓、計畫護欄(全tried)抓到", () => {
  // 情境：第1回合試過做法 X 並記進計畫 tried；中間漂移了幾回合（最近3回合都不是 X）；
  // 第6回合決策模型又提出等同 X 的做法（換句話說但實質相同）。
  const approachX = "重讀整份規格再逐節比對";
  const recentTurns: WorkerAutopilotTurn[] = [
    { instruction: "改用單元測試切入", result: "..." },
    { instruction: "整理既有筆記", result: "..." },
    { instruction: "畫一張流程圖", result: "..." },
  ]; // 最近3回合都不含 X
  const circlingDecision: WorkerAutopilotDecision = {
    action: "continue",
    instruction: "重讀 整份規格 再逐節比對", // 等同 X（只差空白，護欄正規化後相同）
    reason: "再對一次規格",
  };

  // 舊護欄：只看最近3回合 → 抓不到（仍 continue，繼續繞圈）
  const oldGuarded = workerAutopilotProgressGuard(circlingDecision, recentTurns);
  assert.equal(oldGuarded.action, "continue");

  // 計畫護欄：X 在完整 tried 裡 → 抓到，轉 stop
  const plan: WorkerAutopilotPlan = normalizeWorkerAutopilotPlan({
    goal: "完成交付",
    tried: [{ text: approachX, outcome: "沒有進展、資訊都已掌握" }],
  });
  const planGuarded = workerAutopilotPlanProgressGuard(circlingDecision, plan);
  assert.equal(planGuarded.action, "stop");
  assert.match((planGuarded as { reason: string }).reason, /長程繞圈/);
});

test("gate-1：真正前進的新做法不被計畫護欄誤殺", () => {
  const plan = normalizeWorkerAutopilotPlan({ goal: "G", tried: [{ text: "試過的老路", outcome: "不行" }] });
  const fresh: WorkerAutopilotDecision = { action: "continue", instruction: "改用全新的切入角度 Z", reason: "換角度" };
  assert.equal(workerAutopilotPlanProgressGuard(fresh, plan).action, "continue");
});

test("gate-1：計畫為空時護欄不介入（守命優先，交給既有護欄與 prompt）", () => {
  const empty = normalizeWorkerAutopilotPlan(null);
  const d: WorkerAutopilotDecision = { action: "continue", instruction: "任何一步", reason: "r" };
  assert.equal(workerAutopilotPlanProgressGuard(d, empty).action, "continue");
});

// ── prompt＋parse 接線（決策每回合讀計畫、回傳更新後計畫）─────────────────────
test("workerAutopilotNextPrompt：帶計畫時注入計畫區塊與維護規則與 plan schema", () => {
  const plan = normalizeWorkerAutopilotPlan({ goal: "G", tried: [{ text: "試X", outcome: "撞牆" }] });
  const p = workerAutopilotNextPrompt({
    workerName: "W", role: null, workspaceLabel: "d:/測試", turns: [], stepsRemaining: 3, proactive: true, plan,
  });
  assert.match(p, /MAINTAIN THE LIVING PLAN/);
  assert.match(p, /Living plan \(the single evolving source of truth/);
  assert.match(p, /試X → 撞牆/);
  assert.match(p, /"plan":\{"goal"/); // schema 要求回傳 plan
});

test("workerAutopilotNextPrompt：無計畫時仍含維護規則但不注入空區塊", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "W", role: null, workspaceLabel: "d:/測試", turns: [], stepsRemaining: 3, proactive: true,
  });
  assert.match(p, /MAINTAIN THE LIVING PLAN/);
  assert.doesNotMatch(p, /Living plan \(the single evolving source of truth/);
});

test("parseWorkerAutopilotDecision：帶 plan 時原樣帶出 planUpdate（物件）", () => {
  const text = `<worker_autopilot_next>{"action":"continue","instruction":"下一步","reason":"r","plan":{"goal":"G","tried":[{"text":"a","outcome":"b"}]}}</worker_autopilot_next>`;
  const d = parseWorkerAutopilotDecision(text);
  assert.ok(d && d.action === "continue");
  assert.ok(d.planUpdate && typeof d.planUpdate === "object");
  const merged = mergeWorkerAutopilotPlan(normalizeWorkerAutopilotPlan(null), d.planUpdate, 1);
  assert.equal(merged.plan.goal, "G");
  assert.equal(merged.plan.tried[0].outcome, "b");
  assert.equal(merged.changed, true);
});

test("parseWorkerAutopilotDecision：plan 非物件（陣列/字串）時不帶 planUpdate", () => {
  const text = `<worker_autopilot_next>{"action":"stop","reason":"done","plan":["bad"]}</worker_autopilot_next>`;
  const d = parseWorkerAutopilotDecision(text);
  assert.ok(d && d.action === "stop");
  assert.equal(d.planUpdate, undefined);
});

// ── 持久化 round-trip ──────────────────────────────────────────────────────
test("WorkerAutopilotPlanStore：存讀 round-trip、丟棄空計畫與壞檔", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wap-plan-"));
  try {
    const store = new WorkerAutopilotPlanStore(dir);
    assert.deepEqual(store.load(), {}); // 檔案不存在 → 空
    const plan = seedWorkerAutopilotPlan("目標", ["教訓"]);
    store.save({ w1: plan, wEmpty: normalizeWorkerAutopilotPlan(null) });
    const loaded = store.load();
    assert.equal(loaded.w1.goal, "目標");
    assert.equal(loaded.w1.tried[0].text, "教訓");
    assert.equal(loaded.wEmpty, undefined); // 空計畫不落盤
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
