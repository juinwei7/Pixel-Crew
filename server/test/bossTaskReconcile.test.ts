import assert from "node:assert/strict";
import test from "node:test";
import {
  BossTaskWorkCounter,
  restartBlockedByActiveWork,
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
