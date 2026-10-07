import assert from "node:assert/strict";
import test from "node:test";
import {
  BossTaskWorkCounter,
  newCrewOrphaned,
  pendingQuestionUnchanged,
  restartBlockedByActiveWork,
  snapshotStillCurrent,
  synthesizingZombieAction,
} from "../src/bossTaskReconcile.js";

test("synthesizingZombieAction: 交付俱在才自動重新驗收，其餘誠實轉 needs_attention", () => {
  // 正常殭屍形狀：所有部門 stage 都 completed、只是驗收核對被重啟打斷 → 重新驗收。
  assert.equal(
    synthesizingZombieAction([{ status: "completed" }, { status: "completed" }]),
    "resynthesize",
  );
  // 沒有任何 stage（探索沒排出計畫就進 synthesizing 的異常形狀）→ 不敢自動收，交回人工。
  assert.equal(synthesizingZombieAction([]), "needs_attention");
  // 有 stage 沒跑完 → 同樣不自動收。
  assert.equal(
    synthesizingZombieAction([{ status: "completed" }, { status: "running" }]),
    "needs_attention",
  );
  assert.equal(
    synthesizingZombieAction([{ status: "completed" }, { status: "failed" }]),
    "needs_attention",
  );
});

test("restartBlockedByActiveWork: 只擋真的有背景在跑的探索/驗收，殭屍與其他狀態放行", () => {
  // 探索真的在跑（重啟前的正常情境）→ 409 擋下合理。
  assert.equal(
    restartBlockedByActiveWork({ status: "discovering", discoveryInFlight: true, synthesisInFlight: false }),
    true,
  );
  // 探索殭屍（重啟後 status 卡著、但本程序沒有任何探索工作）→ 放行手動重開（P0 修正核心）。
  assert.equal(
    restartBlockedByActiveWork({ status: "discovering", discoveryInFlight: false, synthesisInFlight: false }),
    false,
  );
  // 驗收同理。
  assert.equal(
    restartBlockedByActiveWork({ status: "synthesizing", discoveryInFlight: false, synthesisInFlight: true }),
    true,
  );
  assert.equal(
    restartBlockedByActiveWork({ status: "synthesizing", discoveryInFlight: false, synthesisInFlight: false }),
    false,
  );
  // 其他狀態從不由這個守門擋（各自有原本的判斷）。
  for (const status of ["running", "ready", "needs_attention", "needs_input", "completed", "failed", "cancelled"]) {
    assert.equal(
      restartBlockedByActiveWork({ status, discoveryInFlight: true, synthesisInFlight: true }),
      false,
      status,
    );
  }
});

test("情境：追問（runDedicatedFollowUp）進行中 /restart 要被擋，結束或重啟蒸發後放行（自審發現的漏洞）", () => {
  const counter = new BossTaskWorkCounter();
  const view = () => ({
    status: "discovering",
    discoveryInFlight: counter.inFlight("task"),
    synthesisInFlight: false,
  });
  // 追問開跑（狀態 discovering、工作 in-flight）→ 409 擋下，不能讓 restart 與追問互踩。
  counter.enter("task");
  assert.equal(restartBlockedByActiveWork(view()), true);
  // 追問收尾（正常結束或拋出，finally 都會 exit）→ 之後若狀態仍卡 discovering 就是殭屍，放行。
  counter.exit("task");
  assert.equal(restartBlockedByActiveWork(view()), false);
  // 重啟後（計數器是記憶體態，開機為空）→ 同樣放行手動重開。
  assert.equal(restartBlockedByActiveWork({ status: "discovering", discoveryInFlight: new BossTaskWorkCounter().inFlight("task"), synthesisInFlight: false }), false);
});

test("BossTaskWorkCounter: 遞迴進出（decideBossTask 降級重決策）不會被內層 exit 誤清", () => {
  const counter = new BossTaskWorkCounter();
  assert.equal(counter.inFlight("t1"), false);
  counter.enter("t1"); // 外層 decideBossTask
  counter.enter("t1"); // 內層遞迴 decideBossTask(task, false)
  counter.exit("t1"); // 內層結束——外層還在跑
  assert.equal(counter.inFlight("t1"), true);
  counter.exit("t1"); // 外層結束
  assert.equal(counter.inFlight("t1"), false);
  // 多餘的 exit 不會讓下一次 enter 失效（防禦：計數不落到負值）。
  counter.exit("t1");
  counter.enter("t1");
  assert.equal(counter.inFlight("t1"), true);
  counter.exit("t1");
  assert.equal(counter.inFlight("t1"), false);
  // 不同 task 互不影響。
  counter.enter("a");
  assert.equal(counter.inFlight("b"), false);
});

test("snapshotStillCurrent: 長流程回來後只有同一階段、沒被終結的交辦能套用快照", () => {
  assert.equal(snapshotStillCurrent("discovering", { status: "discovering" }), true);
  // 期間被刪除：寫回會被 upsert 復活。
  assert.equal(snapshotStillCurrent("discovering", null), false);
  assert.equal(snapshotStillCurrent("discovering", undefined), false);
  // 期間被取消／判失敗：寫回會把取消蓋掉、甚至真的派工。
  assert.equal(snapshotStillCurrent("discovering", { status: "cancelled" }), false);
  assert.equal(snapshotStillCurrent("needs_attention", { status: "failed" }), false);
  // 期間被別條路徑接手（老闆回覆、另一輪重試把它推進）：不能拿舊快照再走一遍。
  assert.equal(snapshotStillCurrent("needs_attention", { status: "discovering" }), false);
  assert.equal(snapshotStillCurrent("needs_attention", { status: "needs_attention" }), true);
});

test("pendingQuestionUnchanged: 代答只送給當初那一題", () => {
  const asked = { status: "needs_input", messages: [{ id: "m1", role: "boss" }, { id: "q1", role: "decision_model" }] };
  assert.equal(pendingQuestionUnchanged(asked, structuredClone(asked)), true);
  assert.equal(pendingQuestionUnchanged(asked, null), false);
  // 老闆已親自回覆，交辦回到探索中。
  assert.equal(pendingQuestionUnchanged(asked, { ...asked, status: "discovering" }), false);
  // 老闆回覆後決策模型又問了新的一題：狀態一樣是 needs_input，但那已是另一題。
  assert.equal(pendingQuestionUnchanged(asked, {
    status: "needs_input",
    messages: [...asked.messages, { id: "r1", role: "boss" }, { id: "q2", role: "decision_model" }],
  }), false);
});

test("newCrewOrphaned: 第二輪決策沒把工作交給新隊就要收掉", () => {
  const routed = { status: "running", stages: [{ departmentId: "crew" }] };
  assert.equal(newCrewOrphaned(routed, "crew"), false);
  assert.equal(newCrewOrphaned(null, "crew"), true);
  assert.equal(newCrewOrphaned({ ...routed, status: "cancelled" }, "crew"), true);
  // 決策失敗或改問老闆：沒有 stage 指向它，取消／刪除／封存的清理都找不到它。
  assert.equal(newCrewOrphaned({ status: "failed", stages: [] }, "crew"), true);
  assert.equal(newCrewOrphaned({ status: "needs_input", stages: [] }, "crew"), true);
  assert.equal(newCrewOrphaned({ status: "running", stages: [{ departmentId: "standing" }] }, "crew"), true);
});
