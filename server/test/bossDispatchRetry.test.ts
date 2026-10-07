import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_DISPATCH_RETRY_COOLDOWN_MS,
  BOSS_DISPATCH_RETRY_MAX_ATTEMPTS,
  BossDispatchRetryTracker,
  dispatchRetryAction,
  isPreDispatchStall,
  runnableNextStage,
} from "../src/bossDispatchRetry.js";

test("首次登記不設冷卻：主管一空出就能立刻重派", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("task-1", 1_000);
  assert.equal(tracker.shouldRetry("task-1", 1_000), true);
  assert.equal(tracker.size, 1);
});

test("未登記的交辦不會被重派", () => {
  const tracker = new BossDispatchRetryTracker();
  assert.equal(tracker.shouldRetry("ghost", 999_999), false);
  assert.equal(tracker.exhausted("ghost"), false);
});

test("beginRetry 記次數並進入冷卻；冷卻過後才可再試", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("task-1", 1_000);
  assert.equal(tracker.beginRetry("task-1", 1_000), 1);
  assert.equal(tracker.shouldRetry("task-1", 1_000 + BOSS_DISPATCH_RETRY_COOLDOWN_MS - 1), false);
  assert.equal(tracker.shouldRetry("task-1", 1_000 + BOSS_DISPATCH_RETRY_COOLDOWN_MS), true);
});

test("重派後又卡回來（note 既有條目）延後冷卻但不重置次數", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("task-1", 1_000);
  tracker.beginRetry("task-1", 1_000);
  tracker.note("task-1", 50_000); // 再度卡住
  assert.equal(tracker.shouldRetry("task-1", 50_000 + BOSS_DISPATCH_RETRY_COOLDOWN_MS - 1), false);
  assert.equal(tracker.shouldRetry("task-1", 50_000 + BOSS_DISPATCH_RETRY_COOLDOWN_MS), true);
  assert.equal(tracker.beginRetry("task-1", 60_000), 2); // 次數累計，不歸零
});

test("次數用盡後 shouldRetry 永遠 false 且 exhausted 為真", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("task-1", 0);
  let now = 0;
  for (let i = 1; i <= BOSS_DISPATCH_RETRY_MAX_ATTEMPTS; i += 1) {
    now += BOSS_DISPATCH_RETRY_COOLDOWN_MS;
    assert.equal(tracker.beginRetry("task-1", now), i);
  }
  assert.equal(tracker.exhausted("task-1"), true);
  assert.equal(tracker.shouldRetry("task-1", now + BOSS_DISPATCH_RETRY_COOLDOWN_MS * 10), false);
});

test("resolve 移除追蹤，之後視同全新登記", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("task-1", 1_000);
  tracker.beginRetry("task-1", 1_000);
  tracker.resolve("task-1");
  assert.equal(tracker.size, 0);
  assert.deepEqual(tracker.trackedIds(), []);
  tracker.note("task-1", 2_000);
  assert.equal(tracker.beginRetry("task-1", 2_000), 1); // 次數重新起算
});

test("runnableNextStage：挑依賴都完成的 pending stage，沒有就 null", () => {
  const stages = [
    { id: "a", status: "completed", dependsOn: [] },
    { id: "b", status: "pending", dependsOn: ["a"] },
    { id: "c", status: "pending", dependsOn: ["b"] },
  ];
  assert.equal(runnableNextStage(stages)?.id, "b");
  assert.equal(runnableNextStage([{ id: "x", status: "pending", dependsOn: ["missing"] }]), null);
  assert.equal(runnableNextStage([]), null);
});

test("isPreDispatchStall：只認「needs_attention＋無 stage 在跑＋有可派的下一階段」", () => {
  const pendingStage = { id: "s1", status: "pending", dependsOn: [] as string[] };
  assert.equal(isPreDispatchStall({ status: "needs_attention", stages: [pendingStage] }), true);
  assert.equal(isPreDispatchStall({ status: "running", stages: [pendingStage] }), false);
  // mission 層面的 needs_attention（stage 也標了）要人工處理，不是派工卡住
  assert.equal(isPreDispatchStall({ status: "needs_attention", stages: [{ id: "s1", status: "needs_attention", dependsOn: [] }] }), false);
  assert.equal(isPreDispatchStall({ status: "needs_attention", stages: [{ id: "s1", status: "running", dependsOn: [] }, pendingStage] }), false);
  assert.equal(isPreDispatchStall({ status: "needs_attention", stages: [] }), false);
});

test("情境重演：主管對話中派工卡住 → 忙碌期間只等待 → 閒置後恰好重派一次 → 派出後除名", () => {
  // 2026-09-30 上午 autoResolve 實測的原始劇本，走一遍決策層。
  const tracker = new BossDispatchRetryTracker();
  const stages = [{ id: "s1", status: "pending", dependsOn: [] as string[] }];
  const stalled = (leadEligible: boolean) => ({ status: "needs_attention", stages, leadPresent: true, leadEligible });

  // 派工被擋 → 登記
  tracker.note("task", 0);

  // 主管忙碌期間，turn_end 掃與定期掃來了多輪：全部 wait，一次都不派、不發訊息
  for (const now of [1_000, 15_000, 30_000, 45_000]) {
    assert.deepEqual(dispatchRetryAction(tracker, "task", stalled(false), now), { kind: "wait" });
  }

  // 主管閒置：同一時刻 turn_end 掃先到 → 恰好重派一次
  const first = dispatchRetryAction(tracker, "task", stalled(true), 60_000);
  assert.deepEqual(first, { kind: "retry", attempt: 1 });
  // 緊接著定期掃也到（重派中/剛重派完）：冷卻擋住，不會重複派工也不會重複訊息
  assert.deepEqual(dispatchRetryAction(tracker, "task", stalled(true), 60_001), { kind: "wait" });

  // 派工成功後交辦轉 running：任何後續掃描都判 drop → 除名
  const running = { status: "running", stages: [{ id: "s1", status: "running", dependsOn: [] as string[] }], leadPresent: true, leadEligible: false };
  assert.deepEqual(dispatchRetryAction(tracker, "task", running, 61_000), { kind: "drop" });
  tracker.resolve("task");
  assert.equal(tracker.size, 0);
});

test("dispatchRetryAction：主管消失 drop、次數用盡 exhausted", () => {
  const tracker = new BossDispatchRetryTracker();
  const stages = [{ id: "s1", status: "pending", dependsOn: [] as string[] }];
  tracker.note("task", 0);
  assert.deepEqual(
    dispatchRetryAction(tracker, "task", { status: "needs_attention", stages, leadPresent: false, leadEligible: false }, 0),
    { kind: "drop" },
  );
  let now = 0;
  for (let i = 0; i < BOSS_DISPATCH_RETRY_MAX_ATTEMPTS; i += 1) {
    now += BOSS_DISPATCH_RETRY_COOLDOWN_MS;
    tracker.beginRetry("task", now);
  }
  assert.deepEqual(
    dispatchRetryAction(tracker, "task", { status: "needs_attention", stages, leadPresent: true, leadEligible: true }, now + BOSS_DISPATCH_RETRY_COOLDOWN_MS),
    { kind: "exhausted" },
  );
});

test("多張交辦互不干擾", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("a", 0);
  tracker.note("b", 0);
  tracker.beginRetry("a", 0);
  assert.equal(tracker.shouldRetry("a", 1), false); // a 冷卻中
  assert.equal(tracker.shouldRetry("b", 1), true); // b 不受影響
  assert.deepEqual(tracker.trackedIds().sort(), ["a", "b"]);
});
