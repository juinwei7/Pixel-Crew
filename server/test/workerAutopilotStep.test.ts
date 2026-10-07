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
    { instruction: "🔁（自動循環）檢查設定檔的 timeout 並回報", result: same },
    { instruction: "🔁（自動循環）再檢查一次設定檔的 timeout 並回報", result: same + "。" },
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

test("踏步訊號（真實回放校準）：空回合、等背景工作、換句話說重下同一招", () => {
  // 空回合：短到舊版長度門檻會濾掉的「No response requested.」
  const empty = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）確認部署結果", result: "No response requested." },
    { instruction: "🔁（自動循環）整理部署紀錄", result: "No response requested." },
  ]);
  assert.ok(empty.some((s) => /empty or word-for-word identical/.test(s)));

  // 等待空轉：兩步都只回「還在跑，完成會叫醒我」
  const waiting = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）檢查 B 階段進度", result: "主編排還在 B 階段，背景代理還在跑，完成會自動叫醒我。" },
    { instruction: "🔁（自動循環）確認 B 階段是否完成", result: "B 階段仍在進行，已掛好監看，等它回來再接著做。" },
  ]);
  assert.ok(waiting.some((s) => /waiting on background work/.test(s)));

  // 換句話說重下同一招（真實案例相似度 ~0.7，舊門檻 0.75 抓不到）
  const reissued = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）讀監看輸出，解卡後回填附錄", result: "第 1 次解卡腳本已掛好，35 秒後觸發。" },
    { instruction: "🔁（自動循環）再讀一次監看輸出，解卡後把附錄回填完", result: "附錄已回填第一段，第二段等解卡結果。" },
  ]);
  assert.ok(reissued.some((s) => /re-issued in different words/.test(s)));

  // owner 自己重貼同一段話不算教練踏步
  const owner = workerAutopilotStallSignals([
    { instruction: "請幫我讀監看輸出，解卡後回填附錄", result: "已讀完監看輸出，卡在權限，改用唯讀方式取得資料後回填了附錄第一段。" },
    { instruction: "請幫我讀監看輸出，解卡後回填附錄", result: "附錄第二段也回填完成，並附上三筆來源連結與驗證結果，整份附錄已可交付。" },
  ]);
  assert.deepEqual(owner, []);

  // 長回覆裡提到背景工作、但有實質產出 → 不算等待空轉
  const busy = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）實作匯出功能", result: `${"新增 CSV 匯出與測試，".repeat(80)}剩下的整合測試在背景跑。` },
    { instruction: "🔁（自動循環）補上錯誤處理", result: `${"補上三種錯誤路徑與對應測試，".repeat(60)}完整測試還在跑。` },
  ]);
  assert.ok(!busy.some((s) => /waiting on background work/.test(s)));
});

test("踏步訊號（語意層）：開跑後空等、重做已完成的事；正常進度與 owner 指示不誤報", () => {
  // 前一則較長、開頭狀態行就說丟去背景跑；這一則只剩在等 → 等待空轉
  const launchedThenWaiting = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）做一輪真機行為驗證", result: `壓測已重新開跑（三階段，約 8 分鐘，背景執行）：${"每階段量測延遲與錯誤率並截錄 log，".repeat(25)}` },
    { instruction: "🔁（自動循環）收割三階段結果", result: "第一階段數據已成形，其餘還要約 5 分鐘，跑完的通知會叫醒我，屆時再逐項收割。" },
  ]);
  assert.ok(launchedThenWaiting.some((s) => /waiting on background work/.test(s)));

  // 長回覆只在中段順口提到背景、最新一則有實質產出 → 不算
  const midMention = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）補測試", result: `${"新增邊界測試與修正，".repeat(30)}期間整合測試在背景跑。${"另外整理了錯誤訊息，".repeat(30)}` },
    { instruction: "🔁（自動循環）修 lint", result: "修掉 12 個 lint 警告並補上型別，全部測試綠燈，已提交。" },
  ]);
  assert.ok(!midMention.some((s) => /waiting on background work/.test(s)));

  // 循環派的事 NPC 說早就做完了 → 重做已完成的事
  const redo = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）移除卡片下方多餘的工具標籤", result: "實機檢查：那個標籤早就移除且已上線，不是待辦；我沒有重做。" },
  ]);
  assert.ok(redo.some((s) => /already done earlier/.test(s)));
  const redoEn = workerAutopilotStallSignals([
    { instruction: "🔁 (autopilot) add retry to the uploader", result: "Checked the code: retry with backoff was already implemented two commits ago, so there is nothing to add." },
  ]);
  assert.ok(redoEn.some((s) => /already done earlier/.test(s)));

  // 一般進度回報的「已完成」不算；owner 自己的指示也不算（是 owner 在問，不是循環繞圈）
  const progress = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）補上匯出功能", result: "已完成 CSV 匯出與三個測試，全部通過，下一步處理錯誤路徑。" },
  ]);
  assert.ok(!progress.some((s) => /already done earlier/.test(s)));
  const ownerAsk = workerAutopilotStallSignals([
    { instruction: "那個標籤移掉了嗎？", result: "那個標籤早就移除且已上線了。" },
  ]);
  assert.ok(!ownerAsk.some((s) => /already done earlier/.test(s)));

  // 刻意不上的訊號：連續把選擇丟回 owner——回放裡 NPC 常邊等拍板邊產出，文字層分不開
  const handoff = workerAutopilotStallSignals([
    { instruction: "🔁（自動循環）量測重試間隔", result: "量了 12 次樣本，最慢 23 秒。要改間隔請你決定：A 維持／B 縮短，你回一個字母。" },
    { instruction: "🔁（自動循環）補上量測依據", result: "補上分佈圖與排除依據，數據撐得住 B。仍需你拍板：A 還是 B？" },
    { instruction: "🔁（自動循環）把結論收進報告", result: "結論已寫進報告第三節並附原始數據。A 或 B 等你拍板，回一個字母即可。" },
  ]);
  assert.deepEqual(handoff, []);
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
