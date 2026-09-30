import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPT_CREATE_RETRY_BASE_COOLDOWN_MS,
  DEPT_CREATE_RETRY_MAX_ATTEMPTS,
  DEPT_CREATE_RETRY_MAX_COOLDOWN_MS,
  DeptCreateRetryTracker,
  deptCreateRetryAction,
  deptCreateRetryBackoffMs,
} from "../src/bossDeptCreateRetry.js";

const CREATE_ERR = "無法自動建立專屬臨時部門（工作區忙碌）";
const freeView = { status: "needs_attention", taskError: CREATE_ERR, workspaceFree: true, providerReady: true, inFlight: false };

test("指數退避：15s → 30s → 60s，封頂 120s", () => {
  assert.equal(deptCreateRetryBackoffMs(0), DEPT_CREATE_RETRY_BASE_COOLDOWN_MS);
  assert.equal(deptCreateRetryBackoffMs(1), DEPT_CREATE_RETRY_BASE_COOLDOWN_MS * 2);
  assert.equal(deptCreateRetryBackoffMs(2), DEPT_CREATE_RETRY_BASE_COOLDOWN_MS * 4);
  assert.equal(deptCreateRetryBackoffMs(3), DEPT_CREATE_RETRY_MAX_COOLDOWN_MS);
  assert.equal(deptCreateRetryBackoffMs(99), DEPT_CREATE_RETRY_MAX_COOLDOWN_MS);
});

test("首次登記從基本退避起算（不立刻重打規劃 LLM）", () => {
  const tracker = new DeptCreateRetryTracker();
  tracker.note("task-1", "dedicated", null, CREATE_ERR, 1_000);
  assert.equal(tracker.shouldRetry("task-1", 1_000), false);
  assert.equal(tracker.shouldRetry("task-1", 1_000 + DEPT_CREATE_RETRY_BASE_COOLDOWN_MS), true);
});

test("重試又失敗（note 既有條目）不重置次數，退避隨次數加深；kind/追問/文案以最新為準", () => {
  const tracker = new DeptCreateRetryTracker();
  tracker.note("task-1", "dedicated", null, CREATE_ERR, 0);
  assert.equal(tracker.beginRetry("task-1", DEPT_CREATE_RETRY_BASE_COOLDOWN_MS), 1);
  const FOLLOW_ERR = "無法為追問重建專屬部門";
  tracker.note("task-1", "follow_up", "追問文字", FOLLOW_ERR, 100_000); // 重試失敗，入口重新登記
  const entry = tracker.get("task-1");
  assert.equal(entry?.attempts, 1); // 不歸零
  assert.equal(entry?.kind, "follow_up");
  assert.equal(entry?.followUp, "追問文字");
  assert.equal(entry?.error, FOLLOW_ERR);
  assert.equal(tracker.shouldRetry("task-1", 100_000 + deptCreateRetryBackoffMs(1) - 1), false);
  assert.equal(tracker.shouldRetry("task-1", 100_000 + deptCreateRetryBackoffMs(1)), true);
});

test("情境：工作區忙碌時 wait 不消耗次數，空出後 retry，成功後 drop（重試後成功路徑）", () => {
  const tracker = new DeptCreateRetryTracker();
  tracker.note("task-1", "dedicated", null, CREATE_ERR, 0);
  const ready = DEPT_CREATE_RETRY_BASE_COOLDOWN_MS;
  // 退避已過但工作區還在跑 Mission → wait，且次數不動
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, workspaceFree: false }, ready), { kind: "wait" });
  assert.equal(tracker.get("task-1")?.attempts, 0);
  // provider 沒就緒也一樣 wait
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, providerReady: false }, ready), { kind: "wait" });
  // 工作區空出 → 發動第 1 次重試
  const action = deptCreateRetryAction(tracker, "task-1", freeView, ready);
  assert.equal(action.kind, "retry");
  assert.equal(action.kind === "retry" && action.attempt, 1);
  assert.equal(action.kind === "retry" && action.entry.kind, "dedicated");
  // 重試在跑（inFlight）期間再掃 → wait，不重疊發動
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, inFlight: true }, ready + 999_999), { kind: "wait" });
  // 重試成功：任務離開 needs_attention → drop（呼叫端據此除名）
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, status: "running" }, ready + 999_999), { kind: "drop" });
});

test("情境：連續失敗到上限 → exhausted 降級（呼叫端發訊息除名），不靜默續跑", () => {
  const tracker = new DeptCreateRetryTracker();
  tracker.note("task-1", "decide", null, CREATE_ERR, 0);
  let now = 0;
  for (let round = 1; round <= DEPT_CREATE_RETRY_MAX_ATTEMPTS; round += 1) {
    now += DEPT_CREATE_RETRY_MAX_COOLDOWN_MS; // 跳過退避
    const action = deptCreateRetryAction(tracker, "task-1", freeView, now);
    assert.equal(action.kind, "retry");
    assert.equal(action.kind === "retry" && action.attempt, round);
    tracker.note("task-1", "decide", null, CREATE_ERR, now); // 模擬入口又失敗、重新登記
  }
  now += DEPT_CREATE_RETRY_MAX_COOLDOWN_MS;
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", freeView, now), { kind: "exhausted" });
  // 呼叫端 resolve 後不再追蹤；使用者手動回覆再失敗會重新登記、次數重新起算
  tracker.resolve("task-1");
  assert.equal(tracker.size, 0);
  tracker.note("task-1", "decide", null, CREATE_ERR, now);
  assert.equal(tracker.get("task-1")?.attempts, 0);
});

test("未登記或已推進的交辦一律 drop；追問文字跟著 retry 帶回", () => {
  const tracker = new DeptCreateRetryTracker();
  assert.deepEqual(deptCreateRetryAction(tracker, "ghost", freeView, 999_999), { kind: "drop" });
  const FOLLOW_ERR = "無法為追問重建專屬部門";
  tracker.note("task-2", "follow_up", "接續上次的結論補一版摘要", FOLLOW_ERR, 0);
  assert.deepEqual(deptCreateRetryAction(tracker, "task-2", { ...freeView, taskError: FOLLOW_ERR, status: "cancelled" }, 999_999), { kind: "drop" });
  const action = deptCreateRetryAction(tracker, "task-2", { ...freeView, taskError: FOLLOW_ERR }, DEPT_CREATE_RETRY_BASE_COOLDOWN_MS);
  assert.equal(action.kind === "retry" && action.entry.followUp, "接續上次的結論補一版摘要");
});

// ── 交互自審（2026-09-30）補鎖：兩引擎／派工引擎互踩防護 ────────────────────

test("task.error 換人（重試成功後改因派工被擋、或換成用量受限）→ drop 作廢，不重建重複部門", () => {
  const tracker = new DeptCreateRetryTracker();
  tracker.note("task-1", "dedicated", null, CREATE_ERR, 0);
  const later = DEPT_CREATE_RETRY_BASE_COOLDOWN_MS;
  // 重試成功建好部門後，交辦改因「派工被擋」回到 needs_attention（error 換了）——
  // 若不作廢，這裡會對已有部門的交辦再建一支重複的專屬部門
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, taskError: "「臨時隊」暫時無法開始：主管忙碌中" }, later), { kind: "drop" });
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, taskError: "Claude 無法進行任務判斷：視窗已用盡" }, later), { kind: "drop" });
  assert.deepEqual(deptCreateRetryAction(tracker, "task-1", { ...freeView, taskError: null }, later), { kind: "drop" });
  // 同文案才認領
  assert.equal(deptCreateRetryAction(tracker, "task-1", freeView, later).kind, "retry");
});
