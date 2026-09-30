import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_AUTOPILOT_DEFAULT_STEPS,
  WORKER_AUTOPILOT_MAX_MINUTES,
  WORKER_AUTOPILOT_MAX_RETROS,
  WORKER_AUTOPILOT_MAX_STEPS,
  WORKER_AUTOPILOT_MIN_STEPS,
  appendWorkerAutopilotRetro,
  clampWorkerAutopilotMinutes,
  clampWorkerAutopilotSteps,
  explainWorkerAutopilotFailure,
  normalizeWorkerAutopilotRetros,
  normalizeWorkerAutopilotStates,
  parseWorkerAutopilotDecision,
  stripWorkerAutopilotPrefix,
  workerAutopilotNextPrompt,
  workerAutopilotProgressGuard,
  type WorkerAutopilotRetro,
} from "../src/workerAutopilot.js";

test("clampWorkerAutopilotSteps bounds to [MIN, MAX] and defaults on garbage", () => {
  assert.equal(clampWorkerAutopilotSteps(undefined), WORKER_AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampWorkerAutopilotSteps("abc"), WORKER_AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampWorkerAutopilotSteps(0), WORKER_AUTOPILOT_MIN_STEPS);
  assert.equal(clampWorkerAutopilotSteps(9999), WORKER_AUTOPILOT_MAX_STEPS);
  assert.equal(clampWorkerAutopilotSteps(7.9), 7);
});

test("clampWorkerAutopilotMinutes: blank/garbage/≤0 → null, positives floored and capped", () => {
  assert.equal(clampWorkerAutopilotMinutes(undefined), null);
  assert.equal(clampWorkerAutopilotMinutes("x"), null);
  assert.equal(clampWorkerAutopilotMinutes(0), null);
  assert.equal(clampWorkerAutopilotMinutes(-5), null);
  assert.equal(clampWorkerAutopilotMinutes(90.7), 90);
  assert.equal(clampWorkerAutopilotMinutes(999999), WORKER_AUTOPILOT_MAX_MINUTES);
});

test("prompt carries worker identity, recent turns, and follow-through-then-stop framing", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: "總指揮",
    workspaceLabel: "d:/測試",
    turns: [
      { instruction: "整理報告", result: "已完成初稿" },
      { instruction: "補上結論" },
    ],
    stepsRemaining: 3,
  });
  assert.match(prompt, /總管小揮/);
  assert.match(prompt, /總指揮/);
  assert.match(prompt, /整理報告/);
  assert.match(prompt, /已完成初稿/);
  assert.match(prompt, /continue with those FIRST before considering STOP/);
  assert.doesNotMatch(prompt, /PREFER CONTINUING/);
  assert.match(prompt, /steps remaining after this one: 3/i);
  assert.match(prompt, /<worker_autopilot_next>/);
});

test("prompt keeps drafts out of outbox; final step demands a wrap-up report", () => {
  const midway = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 2,
  });
  assert.match(midway, /never tell the NPC to put work-in-progress into outbox\//);
  assert.doesNotMatch(midway, /FINAL STEP/);

  const last = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 0,
  });
  assert.match(last, /FINAL STEP: this is the loop's last step/);
  assert.match(last, /wrap-up report for the owner/);
});

test("stripWorkerAutopilotPrefix removes copied 🔁 prefixes (repeated, both paren styles) and keeps the rest", () => {
  assert.equal(stripWorkerAutopilotPrefix("🔁（自動循環·剩 2 步）🔁（剩 2 步）收尾報告"), "收尾報告");
  assert.equal(stripWorkerAutopilotPrefix("🔁(auto loop · 3 left) do the thing"), "do the thing");
  assert.equal(stripWorkerAutopilotPrefix("直接開工，不帶前綴"), "直接開工，不帶前綴");
  // 前綴只剝開頭——內文提到 🔁 不受影響。
  assert.equal(stripWorkerAutopilotPrefix("檢查 🔁（剩 1 步）字樣是否重複"), "檢查 🔁（剩 1 步）字樣是否重複");

  const parsed = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"🔁（自動循環·剩 4 步）驗證輸出","reason":"接續"}</worker_autopilot_next>`,
  );
  assert.deepEqual(parsed, { action: "continue", instruction: "驗證輸出", reason: "接續" });
});

test("proactive prompt lowers the STOP bar and allows beyond-thread work", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "探路阿蒐",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 4,
    proactive: true,
  });
  assert.match(prompt, /PREFER CONTINUING/);
  assert.match(prompt, /PROACTIVELY pick the next most valuable thing/);
  assert.match(prompt, /research an adjacent topic/);
  assert.doesNotMatch(prompt, /continue with those FIRST before considering STOP/);
});

test("parses continue and stop decisions; bounds fields", () => {
  const cont = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"驗證剛寫的檔案內容","reason":"接續驗證"}</worker_autopilot_next>`,
  );
  assert.deepEqual(cont, { action: "continue", instruction: "驗證剛寫的檔案內容", reason: "接續驗證" });

  const stop = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"stop","reason":"工作已收尾"}</worker_autopilot_next>`,
  );
  assert.deepEqual(stop, { action: "stop", reason: "工作已收尾" });

  // 理由結尾句號要剪掉——會被塞進「…{reason}。」模板，不剪會變「。。」。
  const trimmed = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"stop","reason":"任務自然結束。"}</worker_autopilot_next>`,
  );
  assert.deepEqual(trimmed, { action: "stop", reason: "任務自然結束" });
});

test("empty instruction degrades to stop; malformed output → null with explanation", () => {
  const empty = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"  ","reason":"?"}</worker_autopilot_next>`,
  );
  assert.equal(empty?.action, "stop");

  assert.equal(parseWorkerAutopilotDecision("no block"), null);
  assert.match(explainWorkerAutopilotFailure("no block") ?? "", /Missing a <worker_autopilot_next>/);
  assert.match(explainWorkerAutopilotFailure(`<worker_autopilot_next>{bad}</worker_autopilot_next>`) ?? "", /did not parse/);
  assert.match(explainWorkerAutopilotFailure(`<worker_autopilot_next>{"action":"dance"}</worker_autopilot_next>`) ?? "", /"action" must be exactly/);
});

// ── 進化循環三機制 ──────────────────────────────────────────────────────────

test("prompt demands ladder judgment, progress self-check, and a retro on stop/final", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 3,
  });
  assert.match(prompt, /LADDER, not laps/);
  assert.match(prompt, /ONE RUNG HIGHER/);
  assert.match(prompt, /Progress self-check/);
  assert.match(prompt, /STOP honestly/);
  assert.match(prompt, /include "retro"/);
  assert.match(prompt, /"rung":/);
});

test("prompt frames the decider as an expert coach who diagnoses before directing", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 3,
  });
  assert.match(prompt, /veteran expert/);
  assert.match(prompt, /COACH like an expert/);
  assert.match(prompt, /expert diagnosis/);
  assert.match(prompt, /concrete standard to hit/);
});

test("prompt carries over previous loops' retros, newest first; none → no block", () => {
  const withRetros = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 2,
    retros: ["先驗證再擴充比較省步數", "拆太細會浪費收尾步"],
  });
  assert.match(withRetros, /Lessons carried over from this NPC's previous loops/);
  assert.match(withRetros, /- 先驗證再擴充比較省步數\n- 拆太細會浪費收尾步/);

  const without = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 2,
  });
  assert.doesNotMatch(without, /Lessons carried over/);
});

test("parser keeps rung and retro when present, omits them when blank", () => {
  const cont = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"補回歸測試","reason":"驗證修復","rung":"已修好但未驗證","retro":"  "}</worker_autopilot_next>`,
  );
  assert.deepEqual(cont, { action: "continue", instruction: "補回歸測試", reason: "驗證修復", rung: "已修好但未驗證" });

  const stop = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"stop","reason":"已收尾","retro":"下輪先盤點輸入再開工"}</worker_autopilot_next>`,
  );
  assert.deepEqual(stop, { action: "stop", reason: "已收尾", retro: "下輪先盤點輸入再開工" });
});

test("progress guard: instruction repeating a recent turn converts to honest stop, retro survives", () => {
  const turns = [
    { instruction: "🔁（自動循環·剩 3 步）整理測試報告", result: "已整理" },
    { instruction: "檢查漏網案例" },
  ];
  const repeat = workerAutopilotProgressGuard(
    { action: "continue", instruction: "整理測試報告", reason: "繼續", retro: "教訓一則" },
    turns,
  );
  assert.equal(repeat.action, "stop");
  assert.match(repeat.reason, /誠實停止/);
  assert.equal((repeat as { retro?: string }).retro, "教訓一則");

  // 空白差異／前綴殘留也算重複——比對前先剝前綴、摺疊空白。
  const fuzzy = workerAutopilotProgressGuard(
    { action: "continue", instruction: "🔁（剩 2 步）檢查  漏網案例", reason: "再看一次" },
    turns,
  );
  assert.equal(fuzzy.action, "stop");

  const fresh = workerAutopilotProgressGuard(
    { action: "continue", instruction: "把漏網案例修掉並補測試", reason: "往上一階" },
    turns,
  );
  assert.equal(fresh.action, "continue");

  const stop = workerAutopilotProgressGuard({ action: "stop", reason: "收尾" }, turns);
  assert.deepEqual(stop, { action: "stop", reason: "收尾" });
});

test("normalizeWorkerAutopilotRetros drops garbage and caps per worker", () => {
  const many = Array.from({ length: WORKER_AUTOPILOT_MAX_RETROS + 5 }, (_, i) => ({ at: i, note: `教訓 ${i}` }));
  const restored = normalizeWorkerAutopilotRetros({
    good: [{ at: 1, note: "先驗證再擴充" }, { at: "x", note: "壞 at 仍保留內容" }],
    blank: [{ at: 2, note: "  " }],
    junk: "not a list",
    overflow: many,
  });
  assert.deepEqual(Object.keys(restored).sort(), ["good", "overflow"]);
  assert.deepEqual(restored.good.map((r) => r.note), ["先驗證再擴充", "壞 at 仍保留內容"]);
  assert.equal(restored.good[1].at, 0);
  assert.equal(restored.overflow.length, WORKER_AUTOPILOT_MAX_RETROS);
  assert.equal(restored.overflow[restored.overflow.length - 1].note, `教訓 ${WORKER_AUTOPILOT_MAX_RETROS + 4}`);
  assert.deepEqual(normalizeWorkerAutopilotRetros(null), {});
  assert.deepEqual(normalizeWorkerAutopilotRetros([1]), {});
});

test("appendWorkerAutopilotRetro skips blanks and consecutive duplicates, caps at MAX", () => {
  const retros: Record<string, WorkerAutopilotRetro[]> = {};
  assert.equal(appendWorkerAutopilotRetro(retros, "w1", "  ", 1), false);
  assert.equal(appendWorkerAutopilotRetro(retros, "w1", undefined, 1), false);
  assert.equal(appendWorkerAutopilotRetro(retros, "w1", "先驗證再擴充", 1), true);
  assert.equal(appendWorkerAutopilotRetro(retros, "w1", "先驗證再擴充", 2), false); // 連續重複不洗版
  assert.equal(appendWorkerAutopilotRetro(retros, "w1", "拆太細浪費步數", 3), true);
  assert.deepEqual(retros.w1.map((r) => r.note), ["先驗證再擴充", "拆太細浪費步數"]);

  for (let i = 0; i < WORKER_AUTOPILOT_MAX_RETROS + 3; i++) {
    appendWorkerAutopilotRetro(retros, "w2", `教訓 ${i}`, i);
  }
  assert.equal(retros.w2.length, WORKER_AUTOPILOT_MAX_RETROS);
  assert.equal(retros.w2[retros.w2.length - 1].note, `教訓 ${WORKER_AUTOPILOT_MAX_RETROS + 2}`);
});

test("normalizeWorkerAutopilotStates drops garbage rows and clamps survivors", () => {
  const restored = normalizeWorkerAutopilotStates({
    good: { stepsRemaining: 3, deadlineAt: null },
    tooMany: { stepsRemaining: 9999, deadlineAt: null },
    zero: { stepsRemaining: 0, deadlineAt: null },
    junk: "not an object",
    badSteps: { stepsRemaining: "x", deadlineAt: null },
    keen: { stepsRemaining: 2, deadlineAt: null, proactive: true },
  });
  assert.deepEqual(Object.keys(restored).sort(), ["good", "keen", "tooMany"]);
  assert.equal(restored.good.stepsRemaining, 3);
  assert.equal(restored.good.proactive, false);
  assert.equal(restored.tooMany.stepsRemaining, WORKER_AUTOPILOT_MAX_STEPS);
  assert.equal(restored.keen.proactive, true);
  assert.deepEqual(normalizeWorkerAutopilotStates(null), {});
  assert.deepEqual(normalizeWorkerAutopilotStates([1, 2]), {});
});
