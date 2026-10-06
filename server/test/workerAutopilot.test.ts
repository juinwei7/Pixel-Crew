import assert from "node:assert/strict";
import test from "node:test";
import {
  autopilotContextFromHistory,
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
  workerAutopilotRepairPrompt,
  workerAutopilotResultSummary,
  workerAutopilotSweepAction,
  type WorkerAutopilotRetro,
  type WorkerAutopilotSweepView,
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
  // 拿掉倒數後的新前綴（無「剩 N 步」）也要照剝——否則教練會看到自己的前綴。
  assert.equal(stripWorkerAutopilotPrefix("🔁（自動循環）繼續爬階梯"), "繼續爬階梯");
  assert.equal(stripWorkerAutopilotPrefix("🔁(auto loop · 3 left) do the thing"), "do the thing");
  assert.equal(stripWorkerAutopilotPrefix("直接開工，不帶前綴"), "直接開工，不帶前綴");
  // 前綴只剝開頭——內文提到 🔁 不受影響。
  assert.equal(stripWorkerAutopilotPrefix("檢查 🔁（剩 1 步）字樣是否重複"), "檢查 🔁（剩 1 步）字樣是否重複");

  const parsed = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"🔁（自動循環·剩 4 步）驗證輸出","reason":"接續"}</worker_autopilot_next>`,
  );
  assert.deepEqual(parsed, { action: "continue", instruction: "驗證輸出", reason: "接續" });
});

test("proactive prompt：步數是上限不是配額，持續進化但不灌水，做完就誠實停", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "探路阿蒐",
    role: null,
    workspaceLabel: "d:/測試",
    turns: [],
    stepsRemaining: 4,
    proactive: true,
  });
  assert.match(prompt, /GOAL-ANCHORED, not keep-busy/);
  // 步數是安全上限、不是配額：有價值的下一步就繼續，絕不為了湊步數找事做
  assert.match(prompt, /KEEP EVOLVING — the step count is a SAFETY CEILING, not a quota/);
  assert.match(prompt, /NEVER invent work to use up the count/);
  assert.doesNotMatch(prompt, /USE THE STEP BUDGET/);
  assert.doesNotMatch(prompt, /TARGET amount/);
  // 替 owner 決定：能靠想＋查得出的自己拍，不丟回去
  assert.match(prompt, /DECIDE FOR THE OWNER whatever you can get right/);
  // 做完就停是好結果：看過幾個角度都沒有值得做的下一步就誠實停，並交代做到哪、建議下一輪方向
  assert.match(prompt, /DONE FOR NOW/);
  assert.match(prompt, /Stopping honestly at \(c\) is a good outcome, not a failure/);
  assert.match(prompt, /the angles you checked/);
  assert.doesNotMatch(prompt, /WHEN IN DOUBT, CLIMB/);
  assert.doesNotMatch(prompt, /running out of the allocated steps is the normal, expected stop/);
  // 舊「達成就主動收工」字樣已移除（那是上一版、與乙相反）
  assert.doesNotMatch(prompt, /the correct move is to STOP and hand back/);
  assert.doesNotMatch(prompt, /THE ORIGINAL GOAL \/ REQUEST IS GENUINELY SATISFIED/);
  assert.doesNotMatch(prompt, /PREFER CONTINUING/);
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

// ── 頭尾保留摘要（P2-3）──────────────────────────────────────────────────

test("workerAutopilotResultSummary keeps short text verbatim and preserves head+tail of long text", () => {
  assert.equal(workerAutopilotResultSummary("  短回覆  "), "短回覆");
  const long = `開頭${"甲".repeat(400)}中段${"乙".repeat(600)}結尾的狀態總結`;
  const summary = workerAutopilotResultSummary(long);
  assert.ok(summary.startsWith("開頭"));
  assert.ok(summary.endsWith("結尾的狀態總結"));
  assert.match(summary, /（中略 \d+ 字）/);
  assert.ok(summary.length < long.length);
});

test("workerAutopilotResultSummary: boundary just under head+tail stays uncut", () => {
  const text = "x".repeat(200 + 600 + 24);
  assert.equal(workerAutopilotResultSummary(text), text);
});

// ── 工作區實況入 prompt（P2-4）───────────────────────────────────────────

test("prompt includes workspace facts and cross-check rule only when provided", () => {
  const base = { workerName: "阿測", role: null, workspaceLabel: "C:/ws", turns: [], stepsRemaining: 2 };
  const withFacts = workerAutopilotNextPrompt({
    ...base,
    workspaceFacts: { outbox: ["最終報告.md"], recent: ["draft.md", "notes.txt"] },
  });
  assert.match(withFacts, /Workspace facts \(server-observed just now/);
  assert.match(withFacts, /outbox\/ deliverables: 最終報告\.md/);
  assert.match(withFacts, /recently modified in workspace: draft\.md, notes\.txt/);
  assert.match(withFacts, /Cross-check the NPC's claims against the workspace facts/);
  const without = workerAutopilotNextPrompt(base);
  assert.doesNotMatch(without, /Workspace facts/);
  assert.doesNotMatch(without, /Cross-check the NPC's claims/);
  const empty = workerAutopilotNextPrompt({ ...base, workspaceFacts: { outbox: [], recent: [] } });
  assert.match(empty, /outbox\/ deliverables: \(empty\)/);
});

// ── 格式修復重問（P3-5）──────────────────────────────────────────────────

test("workerAutopilotRepairPrompt carries the base prompt and the rejection reason", () => {
  const repaired = workerAutopilotRepairPrompt("BASE PROMPT", "Missing a <worker_autopilot_next> block.");
  assert.ok(repaired.startsWith("BASE PROMPT"));
  assert.match(repaired, /rejected: Missing a <worker_autopilot_next> block\./);
  assert.match(repaired, /ONLY the single marked <worker_autopilot_next> JSON block/);
});

// ── 保底掃描決策（P1-1／P1-2）────────────────────────────────────────────

function sweepView(overrides: Partial<WorkerAutopilotSweepView>): WorkerAutopilotSweepView {
  return {
    present: true,
    busy: false,
    queued: false,
    yielding: false,
    advancing: false,
    stepsRemaining: 3,
    deadlinePassed: false,
    retry: { registered: false, due: false, exhausted: false },
    ...overrides,
  };
}

test("sweep action: idle armed loop advances; missing worker drops", () => {
  assert.equal(workerAutopilotSweepAction(sweepView({})), "advance");
  assert.equal(workerAutopilotSweepAction(sweepView({ present: false })), "drop");
});

test("sweep action: busy/queued/yielding/advancing always wait — even over step/deadline limits", () => {
  assert.equal(workerAutopilotSweepAction(sweepView({ busy: true })), "wait");
  assert.equal(workerAutopilotSweepAction(sweepView({ queued: true })), "wait");
  assert.equal(workerAutopilotSweepAction(sweepView({ yielding: true })), "wait");
  assert.equal(workerAutopilotSweepAction(sweepView({ advancing: true })), "wait");
  // 最後一步還在跑：步數已 0 但 busy——不得提早發「已達上限」搶走 turn_end 的收尾。
  assert.equal(workerAutopilotSweepAction(sweepView({ busy: true, stepsRemaining: 0 })), "wait");
  assert.equal(workerAutopilotSweepAction(sweepView({ busy: true, deadlinePassed: true })), "wait");
});

test("sweep action: idle over limits disables; retry gates by due/exhausted", () => {
  assert.equal(workerAutopilotSweepAction(sweepView({ stepsRemaining: 0 })), "disable_steps");
  assert.equal(workerAutopilotSweepAction(sweepView({ deadlinePassed: true })), "disable_deadline");
  assert.equal(workerAutopilotSweepAction(sweepView({ retry: { registered: true, due: false, exhausted: false } })), "wait");
  assert.equal(workerAutopilotSweepAction(sweepView({ retry: { registered: true, due: true, exhausted: false } })), "advance");
  assert.equal(workerAutopilotSweepAction(sweepView({ retry: { registered: true, due: false, exhausted: true } })), "exhausted");
});

test("autopilotContextFromHistory：跳過換腦/交接的 system 回合，不誤當工作結果", () => {
  const ctx = autopilotContextFromHistory([
    { type: "user_message", text: "原始任務：把終端機做漂亮" },
    { type: "turn_end", resultText: "已完成終端機美化，改了 CSS。" },
    // 換腦：系統回合，結果是一大份交接摘要——不可被當成最新工作結果
    { type: "user_message", system: true, text: "🧠 自動換腦完成：交接摘要已送進全新工作階段" },
    { type: "turn_end", resultText: "已接手" },
    { type: "user_message", system: true, text: "start_swap 公告" },
    { type: "turn_end", resultText: "先前工作摘要：".padEnd(400, "細節") },
    { type: "user_message", text: "下一步：修 grep 徽章" },
    { type: "turn_end", resultText: "grep 已顯示查資料。" },
  ]);
  // 只有兩個「真實」回合，system 回合完全不進 turns
  assert.equal(ctx.turns.length, 2);
  assert.equal(ctx.turns[0].instruction, "原始任務：把終端機做漂亮");
  assert.equal(ctx.turns[1].instruction, "下一步：修 grep 徽章");
  assert.ok(!ctx.turns.some((turn) => turn.instruction.includes("換腦") || turn.instruction.includes("start_swap")));
});

test("autopilotContextFromHistory：抽出原始目標與換腦帶來的先前摘要（跳過『已接手』短回覆）", () => {
  const longSummary = "先前工作摘要：".padEnd(500, "重點");
  const ctx = autopilotContextFromHistory([
    { type: "user_message", text: "大局目標：打造多代理辦公室" },
    { type: "turn_end", resultText: "起步了。" },
    { type: "user_message", system: true, text: "start_swap" },
    { type: "turn_end", resultText: longSummary },
    { type: "user_message", system: true, text: "🧠 自動換腦完成" },
    { type: "turn_end", resultText: "已接手" },
    { type: "user_message", text: "繼續做徽章" },
    { type: "turn_end", resultText: "徽章完成。" },
  ]);
  assert.equal(ctx.originalGoal, "大局目標：打造多代理辦公室");
  // carriedSummary 取「夠長的那份」摘要，不是後來的「已接手」
  assert.ok(ctx.carriedSummary && ctx.carriedSummary.startsWith("先前工作摘要："));
  assert.notEqual(ctx.carriedSummary, "已接手");
});

test("autopilotContextFromHistory：notice 通知不進回合、沒有換腦時 carriedSummary 為 null", () => {
  const ctx = autopilotContextFromHistory([
    { type: "user_message", text: "任務 A" },
    { type: "turn_end", resultText: "做完 A。" },
    { type: "user_message", notice: true, text: "⏰ 系統通知（純顯示）" },
    { type: "user_message", text: "任務 B" },
    { type: "turn_end", resultText: "做完 B。" },
  ]);
  assert.equal(ctx.turns.length, 2);
  assert.equal(ctx.carriedSummary, null);
  assert.equal(ctx.originalGoal, "任務 A");
});

// ── 循環三病回歸鎖（owner 抱怨：換腦誤讀/不讀前文/不會問；行為乾跑已驗，這裡鎖契約防悄悄復發） ──

test("prompt 契約：卡到 owner 拍板時必須把停止理由寫成標號選項的好問題（一字可答）", () => {
  for (const proactive of [true, false]) {
    const prompt = workerAutopilotNextPrompt({
      workerName: "總管小揮", role: null, workspaceLabel: "d:/測試", turns: [], stepsRemaining: 2, proactive,
    });
    assert.match(prompt, /ASK ONLY WHAT YOU TRULY CANNOT SETTLE/);
    assert.match(prompt, /write the "reason" AS a prepared recommendation/);
    assert.match(prompt, /recommended option \(plus 1–2 alternatives\)/);
    assert.match(prompt, /confirms in a single letter or word/);
  }
});

test("prompt 契約：原始目標與換腦帶來的摘要被釘住，且摘要明令只當背景不可診斷", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "總管小揮", role: null, workspaceLabel: "d:/測試",
    turns: [{ instruction: "下一步", result: "最新結果" }], stepsRemaining: 2,
    originalGoal: "大局目標：打造多代理辦公室",
    carriedSummary: "先前工作摘要：已完成終端機美化與活動徽章",
  });
  assert.match(prompt, /Owner's goal .*FIXED for the whole loop/);
  assert.match(prompt, /大局目標：打造多代理辦公室/);
  assert.match(prompt, /KEEP THE BIG PICTURE/);
  assert.match(prompt, /BACKGROUND ONLY/);
  assert.match(prompt, /never diagnose it/);
  assert.match(prompt, /先前工作摘要：已完成終端機美化與活動徽章/);
  // 沒帶背景時不得出現空區塊與 carried 規則（KEEP THE BIG PICTURE 規則行無條件存在，
  // 反向斷言只釘條件式區塊的專屬字樣）
  const bare = workerAutopilotNextPrompt({ workerName: "總管小揮", role: null, workspaceLabel: "d:/測試", turns: [], stepsRemaining: 2 });
  assert.doesNotMatch(bare, /FIXED for the whole loop/);
  assert.doesNotMatch(bare, /BACKGROUND ONLY/);
});

test("解析契約：真實乾跑的 STOP 好問題回覆（A/B 標號＋一字可答）能被正式解析器吃下且理由完整保留", () => {
  // 逐字取自 3a7e096 補驗 v2 的實際模型輸出（情境2：報告已產出、只剩等拍板）。
  const realReply = `<worker_autopilot_next>{"action":"stop","reason":"接回延遲走向需要您拍板（報告已在 outbox《冷安裝接回-AB決策報告.md》，回一個字母即可）：A＝接受現狀 ~50s，立即收尾結案，零風險（小揮與我的共同建議）；B＝重構為輕量直連 API 拚秒級接回，可達 <5s 但需改架構、有回歸風險且多花數天。請回 A 或 B。","resolvedRequestIds":[],"retro":"便宜優化（換模型、warmup、補掃）全試完才定讞根因是決策 CLI turn 的本質成本——先量測再動手省了彎路；但 sonnet 實測反而更慢提醒：換模型≠必然提速，任何假設都要帶計時數據驗證。"}</worker_autopilot_next>`;
  const decision = parseWorkerAutopilotDecision(realReply);
  assert.ok(decision && decision.action === "stop");
  // 行為特徵：標號選項、推薦、一字可答（不逐字釘模型全文）
  assert.match(decision.reason, /A＝/);
  assert.match(decision.reason, /B＝/);
  assert.match(decision.reason, /共同建議|建議/);
  assert.match(decision.reason, /回一個字母即可/);
  assert.match(decision.reason, /請回 A 或 B/);
  assert.ok("retro" in decision && decision.retro && decision.retro.length > 10);
});

// ── 循環邏輯校正鎖（owner：讓項目進步/離目標更近/最後留簡單決定，別硬找活、別假設同意） ──

test("prompt 契約(proactive)：上限非配額＋替 owner 決定＋做完誠實停，花錢/不可逆仍不假設同意", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "總管小揮", role: null, workspaceLabel: "d:/測試",
    turns: [{ instruction: "上一步", result: "已完成並驗證" }], stepsRemaining: 3, proactive: true,
    originalGoal: "大局目標",
  });
  assert.match(p, /GOAL-ANCHORED, not keep-busy/);
  assert.match(p, /re-doing \/ re-verifying something already shipped or already verified, is busywork/);
  // 上限非配額、替 owner 決定、做完誠實停（交代看過的角度）
  assert.match(p, /KEEP EVOLVING — the step count is a SAFETY CEILING/);
  assert.match(p, /DECIDE FOR THE OWNER whatever you can get right/);
  assert.match(p, /DONE FOR NOW/);
  assert.match(p, /the angles you checked/);
  // 花錢/不可逆仍要 owner 本人授權（保護 owner，不被「替你決定」沖掉）
  assert.match(p, /NEVER PRESUME CONSENT FOR MONEY OR IRREVERSIBLE ACTIONS/);
  assert.match(p, /spends money, cannot be undone, or sends something outward/);
  // 舊「做完就停」與找活引擎字樣都已移除
  assert.doesNotMatch(p, /DONE → hand the owner ONE simple decision/);
  assert.doesNotMatch(p, /PREFER CONTINUING/);
  assert.doesNotMatch(p, /research an adjacent topic/);
});

test("prompt 契約(proactive)：卡住要換角度推進、不繞圈不早停（第二個大腦）", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "總管小揮", role: null, workspaceLabel: "d:/測試",
    turns: [{ instruction: "上一步", result: "卡在同一條路" }], stepsRemaining: 3, proactive: true,
    originalGoal: "大局目標",
  });
  // 換目標＝漂移(禁)，換角度＝卡住時就該做(要)
  assert.match(p, /DIFFERENT ANGLE, SAME GOAL/);
  assert.match(p, /changing the APPROACH is exactly what you should do when the obvious path stalls/);
  assert.match(p, /going in circles/);
  assert.match(p, /do NOT stop prematurely/);
  // 卡住時換角度而非停；但不准為了續命硬編下一階
  assert.match(p, /never invent a rung just to keep going/);
});

test("prompt 契約(非 proactive 也有不假設同意的守則)", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "總管小揮", role: null, workspaceLabel: "d:/測試", turns: [], stepsRemaining: 2, proactive: false,
  });
  assert.match(p, /NEVER PRESUME CONSENT FOR MONEY OR IRREVERSIBLE ACTIONS/);
  assert.match(p, /ASK ONLY WHAT YOU TRULY CANNOT SETTLE/);
});
