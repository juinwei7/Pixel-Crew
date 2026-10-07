import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkerAutopilotStates,
  parseWorkerAutopilotDecision,
  workerAutopilotAutoPickPrompt,
  workerAutopilotChoiceNotice,
  workerAutopilotNextPrompt,
  workerAutopilotPausedNote,
  workerAutopilotShouldAutoPick,
  workerAutopilotSweepAction,
} from "../src/workerAutopilot.js";

const wrap = (obj: unknown) => `<worker_autopilot_next>${JSON.stringify(obj)}</worker_autopilot_next>`;

// ── 選項分岔：循環開著時教練自己選，不停下來等人 ───────────────────────────
test("parse：continue 帶 choice 會被保留；沒給 picked 的 choice 當沒有", () => {
  const d = parseWorkerAutopilotDecision(wrap({
    action: "continue", instruction: "用方案 B 重寫快取層", reason: "B 較穩",
    choice: { question: "快取要用哪種？", options: ["A 記憶體", "B 檔案"], picked: "B 檔案", why: "重啟不會丟。" },
  }));
  assert.ok(d && d.action === "continue");
  assert.deepEqual(d.choice, { question: "快取要用哪種？", options: ["A 記憶體", "B 檔案"], picked: "B 檔案", why: "重啟不會丟" });
  const none = parseWorkerAutopilotDecision(wrap({ action: "continue", instruction: "做 X", reason: "r", choice: { question: "q" } }));
  assert.ok(none && none.action === "continue" && none.choice === undefined);
});

test("parse：stop 的 gate 只收三個合法值", () => {
  const ok = parseWorkerAutopilotDecision(wrap({ action: "stop", kind: "ask", gate: "authorization", reason: "要部署嗎" }));
  assert.ok(ok && ok.action === "stop" && ok.gate === "authorization");
  const bad = parseWorkerAutopilotDecision(wrap({ action: "stop", kind: "ask", gate: "whatever", reason: "x" }));
  assert.ok(bad && bad.action === "stop" && bad.gate === undefined);
});

test("shouldAutoPick：選項題自選；花錢/不可逆/私有資料、done/stuck、continue 都不自選", () => {
  const ask = (extra: object) => parseWorkerAutopilotDecision(wrap({ action: "stop", kind: "ask", reason: "要走哪條？A 先做後端；B 先做前端", ...extra }))!;
  assert.equal(workerAutopilotShouldAutoPick(ask({ gate: "choice" })), true);
  assert.equal(workerAutopilotShouldAutoPick(ask({})), true, "沒標 gate 但帶 ≥2 選項＝選項題");
  assert.equal(workerAutopilotShouldAutoPick(ask({ gate: "authorization" })), false);
  assert.equal(workerAutopilotShouldAutoPick(ask({ gate: "owner_data" })), false);
  const plainAsk = parseWorkerAutopilotDecision(wrap({ action: "stop", kind: "ask", reason: "請給我 API 金鑰" }))!;
  assert.equal(workerAutopilotShouldAutoPick(plainAsk), false, "沒選項、沒 gate 的問題不硬選");
  const done = parseWorkerAutopilotDecision(wrap({ action: "stop", kind: "done", reason: "完成" }))!;
  assert.equal(workerAutopilotShouldAutoPick(done), false);
  const stuck = parseWorkerAutopilotDecision(wrap({ action: "stop", kind: "stuck", reason: "A 試過；B 也試過" }))!;
  assert.equal(workerAutopilotShouldAutoPick(stuck), false);
});

test("autoPickPrompt：帶回原問題、要求 continue＋choice，只准花錢/不可逆再停", () => {
  const p = workerAutopilotAutoPickPrompt("BASE", "要走哪條？A 後端；B 前端");
  assert.ok(p.startsWith("BASE"));
  assert.match(p, /A 後端；B 前端/);
  assert.match(p, /"continue"/);
  assert.match(p, /"choice"/);
  assert.match(p, /"gate":"authorization"/);
});

test("choiceNotice / pausedNote：講清楚選了什麼、為什麼，以及暫停後回覆就會接著跑", () => {
  const n = workerAutopilotChoiceNotice({ question: "快取要用哪種", options: [], picked: "B 檔案", why: "重啟不會丟" });
  assert.match(n, /B 檔案/);
  assert.match(n, /重啟不會丟/);
  assert.match(n, /想改直接回我/);
  assert.match(workerAutopilotPausedNote("要部署到正式站嗎？A 部署；B 先不要", "authorization"), /花錢／不可逆／對外送出/);
  assert.match(workerAutopilotPausedNote("請提供帳號", "owner_data"), /只有你有的資料/);
  assert.match(workerAutopilotPausedNote("x"), /回覆後循環會自動接著跑/);
});

test("prompt：寫明可逆分岔自己選、先做不受阻的部分、ask 要標 gate", () => {
  const p = workerAutopilotNextPrompt({
    workerName: "w", role: null, workspaceLabel: "/x", turns: [], originalGoal: "g", carriedSummary: null,
    stepsRemaining: 3, proactive: true, retros: [], workspaceFacts: null, openRequests: [], plan: null,
    canExplore: false, explorationFindings: [], stallSignals: [],
  } as Parameters<typeof workerAutopilotNextPrompt>[0]);
  assert.match(p, /PICK FORKS YOURSELF/);
  assert.match(p, /FINISH UNBLOCKED WORK BEFORE ASKING/);
  assert.match(p, /"gate":"authorization"/);
  assert.match(p, /a mere preference or an A\/B\/C fork is NOT this/);
  // 剎車規則仍在：花錢/不可逆/對外一定要 owner 本人點頭
  assert.match(p, /NEVER PRESUME CONSENT FOR MONEY OR IRREVERSIBLE ACTIONS/);
});

// ── 暫停：開關留著、跨重啟保留、掃描不推進也不因時限收掉 ─────────────────────
test("normalizeStates：paused 跨重啟保留；壞的 paused 丟掉但不丟整條狀態", () => {
  const out = normalizeWorkerAutopilotStates({
    a: { stepsRemaining: 3, deadlineAt: null, proactive: true, goal: "g", paused: { question: "要部署嗎？A 要；B 不要", options: ["A", "B"], at: 123, gate: "authorization" } },
    b: { stepsRemaining: 3, deadlineAt: null, proactive: true, paused: { question: "", at: "x" } },
  });
  assert.deepEqual(out.a.paused, { question: "要部署嗎？A 要；B 不要", options: ["A", "B"], at: 123, gate: "authorization" });
  assert.ok(out.b);
  assert.equal(out.b.paused, undefined);
});

test("sweepAction：暫停中一律 wait——即使時限已過或步數用完", () => {
  const base = { present: true, busy: false, queued: false, yielding: false, advancing: false, stepsRemaining: 3, deadlinePassed: false, retry: { registered: false, due: false, exhausted: false } };
  assert.equal(workerAutopilotSweepAction({ ...base, paused: true }), "wait");
  assert.equal(workerAutopilotSweepAction({ ...base, paused: true, deadlinePassed: true }), "wait");
  assert.equal(workerAutopilotSweepAction({ ...base, paused: true, stepsRemaining: 0 }), "wait");
  assert.equal(workerAutopilotSweepAction({ ...base, paused: false }), "advance");
  assert.equal(workerAutopilotSweepAction({ ...base, present: false, paused: true }), "drop");
});
