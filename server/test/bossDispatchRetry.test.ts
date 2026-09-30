import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_DISPATCH_RETRY_COOLDOWN_MS,
  BOSS_DISPATCH_RETRY_MAX_ATTEMPTS,
  BossDispatchRetryTracker,
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

test("多張交辦互不干擾", () => {
  const tracker = new BossDispatchRetryTracker();
  tracker.note("a", 0);
  tracker.note("b", 0);
  tracker.beginRetry("a", 0);
  assert.equal(tracker.shouldRetry("a", 1), false); // a 冷卻中
  assert.equal(tracker.shouldRetry("b", 1), true); // b 不受影響
  assert.deepEqual(tracker.trackedIds().sort(), ["a", "b"]);
});
