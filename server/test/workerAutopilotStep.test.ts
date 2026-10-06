import assert from "node:assert/strict";
import test from "node:test";
import {
  autopilotContextFromHistory,
  extractWorkerAutopilotCriterion,
  normalizeWorkerAutopilotPlan,
  parseWorkerAutopilotDecision,
  stripWorkerAutopilotCriterion,
  workerAutopilotInstructionWithCriterion,
  workerAutopilotNextPrompt,
  workerAutopilotPlanProgressGuard,
  workerAutopilotProgressGuard,
  workerAutopilotStallSignals,
  workerAutopilotStepNotice,
  workerAutopilotStopNote,
  workerAutopilotTextSimilarity,
} from "../src/workerAutopilot.js";

const base = { workerName: "總管小揮", role: null, workspaceLabel: "d:/測試", stepsRemaining: 3 } as const;

// ── 完成標準＋上一步驗收 ──────────────────────────────────────────────────────

test("解析：continue 帶 doneWhen/prevMet，stop 帶 kind；非法值一律略過", () => {
  const cont = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"補邊界測試","reason":"驗證修復","doneWhen":"三個邊界案例全綠。","prevMet":"partial"}</worker_autopilot_next>`,
  );
  assert.deepEqual(cont, { action: "continue", instruction: "補邊界測試", reason: "驗證修復", doneWhen: "三個邊界案例全綠", prevMet: "partial" });

  const stop = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"stop","kind":"done","reason":"目標達成","prevMet":"met"}</worker_autopilot_next>`,
  );
  assert.deepEqual(stop, { action: "stop", reason: "目標達成", kind: "done", prevMet: "met" });

  const junk = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"stop","kind":"finished","reason":"x","prevMet":"yes"}</worker_autopilot_next>`,
  );
  assert.deepEqual(junk, { action: "stop", reason: "x" });
});

test("完成標準附在指示尾端，可取回、可剝除；沒標準就原樣", () => {
  const sent = workerAutopilotInstructionWithCriterion("把報告的數據來源補齊", "每個數字都附出處");
  assert.match(sent, /^把報告的數據來源補齊\n\n完成標準：每個數字都附出處\n/);
  assert.equal(extractWorkerAutopilotCriterion(`🔁（自動循環）${sent}`), "每個數字都附出處");
  assert.equal(stripWorkerAutopilotCriterion(sent), "把報告的數據來源補齊");
  assert.equal(workerAutopilotInstructionWithCriterion("原樣", "  "), "原樣");
  assert.equal(extractWorkerAutopilotCriterion("沒有標準的指示"), "");
});

test("脈絡：長指示截斷時完成標準另存不被砍，prompt 把它渲染在該回合下", () => {
  const longBody = "很長的指示".repeat(300);
  const ctx = autopilotContextFromHistory([
    { type: "user_message", text: "大局目標" },
    { type: "turn_end", resultText: "起步" },
    { type: "user_message", text: `🔁（自動循環）${workerAutopilotInstructionWithCriterion(longBody, "outbox 有定稿")}` },
    { type: "turn_end", resultText: "已放定稿" },
  ]);
  const last = ctx.turns[ctx.turns.length - 1];
  assert.equal(last.doneWhen, "outbox 有定稿");
  assert.ok(last.instruction.length <= 600);
  assert.ok(!last.instruction.includes("完成標準"));
  assert.equal(ctx.turns[0].doneWhen, undefined);

  const prompt = workerAutopilotNextPrompt({ ...base, turns: ctx.turns });
  assert.match(prompt, /完成標準 \/ Done when: outbox 有定稿/);
  assert.match(prompt, /CHECK THE LAST CRITERION FIRST/);
  assert.match(prompt, /"prevMet"/);
});

test("進步護欄：上一步帶完成標準時，同一招換個標準措辭仍被抓到，且標成 stuck", () => {
  const ctx = autopilotContextFromHistory([
    { type: "user_message", text: `🔁（自動循環）${workerAutopilotInstructionWithCriterion("整理測試報告", "列出全部失敗案例")}` },
    { type: "turn_end", resultText: "整理好了" },
  ]);
  const guarded = workerAutopilotProgressGuard({ action: "continue", instruction: "整理測試報告", reason: "r", doneWhen: "換個說法" }, ctx.turns);
  assert.equal(guarded.action, "stop");
  assert.equal((guarded as { kind?: string }).kind, "stuck");

  const plan = normalizeWorkerAutopilotPlan({ goal: "g", tried: [{ text: "跑基準測試", outcome: "慢" }] });
  const circled = workerAutopilotPlanProgressGuard({ action: "continue", instruction: "跑基準測試", reason: "r" }, plan);
  assert.equal((circled as { kind?: string }).kind, "stuck");
});

// ── 原地踏步軟訊號 ────────────────────────────────────────────────────────────

test("相似度：相同=1、無交集=0、太短=0", () => {
  assert.equal(workerAutopilotTextSimilarity("修正登入流程", "修正登入流程"), 1);
  assert.equal(workerAutopilotTextSimilarity("甲乙丙", "丁戊己"), 0);
  assert.equal(workerAutopilotTextSimilarity("a", "a"), 0);
});

test("踏步訊號：回覆幾乎相同、指示換句話說重下 → 有訊號；正常推進 → 無", () => {
  const same = "已檢查設定檔，發現 timeout 設為 30 秒，建議調高到 60 秒並重跑整合測試確認是否還會逾時。";
  const stalled = workerAutopilotStallSignals([
    { instruction: "檢查設定檔的 timeout 並回報", result: same },
    { instruction: "再檢查一次設定檔的 timeout 並回報", result: same + "。" },
  ]);
  assert.equal(stalled.length, 2);
  assert.match(stalled[0], /replies are ~\d+% the same/);
  assert.match(stalled[1], /re-issued in different words/);

  // A→B→A 擺盪也算
  const swing = workerAutopilotStallSignals([
    { instruction: "改用方案甲實作快取層", result: same },
    { instruction: "量測現在的延遲分佈並列出前三大熱點", result: "量到 p95 為 820ms，熱點是 DB 查詢、序列化、外部 API。" },
    { instruction: "整理成給 owner 的一頁摘要", result: same },
  ]);
  assert.equal(swing.length, 1);

  const healthy = workerAutopilotStallSignals([
    { instruction: "量測現在的延遲分佈並列出前三大熱點", result: "量到 p95 為 820ms，熱點是 DB 查詢、序列化、外部 API 呼叫，其中 DB 佔六成。" },
    { instruction: "針對 DB 查詢加索引並重跑基準", result: "加了兩個複合索引，p95 降到 410ms，序列化變成新的最大熱點，接下來可以處理它。" },
  ]);
  assert.deepEqual(healthy, []);
});

test("prompt：有踏步訊號才注入區塊；換角度與選最佳候選的規則常駐", () => {
  const withStall = workerAutopilotNextPrompt({ ...base, turns: [], stallSignals: ["The last two instructions overlap ~90%"] });
  assert.match(withStall, /STALL SIGNALS \(server-measured/);
  assert.match(withStall, /overlap ~90%/);
  const without = workerAutopilotNextPrompt({ ...base, turns: [] });
  assert.doesNotMatch(without, /STALL SIGNALS/);
  for (const p of [withStall, without]) {
    assert.match(p, /PICK, DON'T DEFAULT/);
    assert.match(p, /why it beats the runner-up/);
    assert.match(p, /DONE-WHEN FOR EVERY STEP/);
    assert.match(p, /"doneWhen":/);
    assert.match(p, /STOP KIND/);
    assert.match(p, /"kind":"done \| ask \| stuck"/);
    // 既有的好問題契約不受影響
    assert.match(p, /ASK ONLY WHAT YOU TRULY CANNOT SETTLE/);
  }
});

// ── 給 owner 看的進度與停止說明 ──────────────────────────────────────────────

test("每步一句話進度：上一步驗收 · 階 · 這步 · 完成標準；全空回 null", () => {
  const notice = workerAutopilotStepNotice({ prevMet: "missed", rung: "已產出未驗證", reason: "先補驗證", doneWhen: "測試全綠" });
  assert.equal(notice, "🪜 上一步未達標 · 已產出未驗證 · 這步：先補驗證 · 完成標準：測試全綠");
  assert.equal(workerAutopilotStepNotice({ rung: "已驗證" }), "🪜 已驗證");
  assert.equal(workerAutopilotStepNotice({}), null);
});

test("停止註記：done 不打擾並附可選下一步；stuck/ask 標成問你；沒給 kind 沿用舊行為", () => {
  const plan = normalizeWorkerAutopilotPlan({ goal: "g", toTry: [{ text: "補英文版" }], blockers: ["缺正式資料庫權限"] });

  const done = workerAutopilotStopNote({ kind: "done", reason: "報告定稿已在 outbox", plan });
  assert.equal(done.ask, false);
  assert.match(done.note, /^自動循環已完成目標：報告定稿已在 outbox。/);
  assert.match(done.note, /可選的下一步：補英文版/);

  // 宣稱 done 但理由裡其實有 A/B 選項 → 仍當問 owner，不漏掉待決定
  const disguised = workerAutopilotStopNote({ kind: "done", reason: "已完成；請選 A＝直接發布 B＝再審一輪", plan });
  assert.equal(disguised.ask, true);
  assert.match(disguised.note, /等你拍板/);

  const stuck = workerAutopilotStopNote({ kind: "stuck", reason: "三個角度都卡在權限", plan });
  assert.equal(stuck.ask, true);
  assert.match(stuck.note, /卡住而停：三個角度都卡在權限/);
  assert.match(stuck.note, /卡點：缺正式資料庫權限/);

  const ask = workerAutopilotStopNote({ kind: "ask", reason: "A＝收尾 B＝重構，請回 A 或 B", plan: null });
  assert.equal(ask.ask, true);
  assert.match(ask.note, /等你拍板：A＝收尾/);

  const legacy = workerAutopilotStopNote({ reason: "工作已收尾" });
  assert.equal(legacy.ask, true);
  assert.equal(legacy.note, "🅿️ 自動循環正常結束：工作已收尾。要繼續就再打開開關或直接下指示。");
  const silent = workerAutopilotStopNote({ kind: "done", reason: "" });
  assert.equal(silent.ask, false);
  assert.equal(silent.note, "🅿️ 自動循環正常結束。要繼續就再打開開關或直接下指示。");
});
