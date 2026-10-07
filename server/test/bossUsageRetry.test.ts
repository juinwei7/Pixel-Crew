import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_RETRY_BASE_COOLDOWN_MS,
  USAGE_RETRY_MAX_COOLDOWN_MS,
  USAGE_RETRY_MAX_PROBES,
  UsageRetryTracker,
  usageRetryAction,
  usageRetryBackoffMs,
  usageStallKind,
} from "../src/bossUsageRetry.js";

// 視圖只餵結構化 stall 標記，不再有 task.error 文案——認領與文案徹底脫鉤。
const view = (over: Partial<{ status: string; stallKind: string | null; inFlight: boolean }> = {}) => ({
  status: "needs_attention",
  stallKind: usageStallKind("dedicated") as string | null,
  inFlight: false,
  ...over,
});

test("探測退避：60s → 2m → 4m，封頂 15m；累計次數涵蓋 5h 用量視窗", () => {
  assert.equal(usageRetryBackoffMs(0), USAGE_RETRY_BASE_COOLDOWN_MS);
  assert.equal(usageRetryBackoffMs(1), USAGE_RETRY_BASE_COOLDOWN_MS * 2);
  assert.equal(usageRetryBackoffMs(2), USAGE_RETRY_BASE_COOLDOWN_MS * 4);
  assert.equal(usageRetryBackoffMs(99), USAGE_RETRY_MAX_COOLDOWN_MS);
  // 24 次探測累計等待要 ≥ 5 小時，否則 5h 視窗重置前就會提前放棄
  let total = 0;
  for (let probe = 0; probe < USAGE_RETRY_MAX_PROBES; probe += 1) total += usageRetryBackoffMs(probe);
  assert.ok(total >= 5 * 60 * 60 * 1000, `累計 ${total}ms 不足 5 小時`);
});

test("情境：耗盡→登記→探測到恢復→重跑成功後 drop（恢復自動重跑路徑）", () => {
  const tracker = new UsageRetryTracker();
  tracker.note("task-1", "dedicated", 0);
  // 首次登記從基本退避起算，不立刻探測
  assert.deepEqual(usageRetryAction(tracker, "task-1", view(), 0), { kind: "wait" });
  // 退避到點 → 發動第 1 次探測（呼叫端此時查即時用量）
  const first = usageRetryAction(tracker, "task-1", view(), USAGE_RETRY_BASE_COOLDOWN_MS);
  assert.equal(first.kind, "probe");
  assert.equal(first.kind === "probe" && first.probe, 1);
  assert.equal(first.kind === "probe" && first.entry.kind, "dedicated");
  // 探測（含重跑）在跑期間再掃 → wait，不重疊發動
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ inFlight: true }), 999_999_999), { kind: "wait" });
  // 重跑成功：任務離開 needs_attention（中央護欄同時會清 stall）→ drop（呼叫端據此除名）
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ status: "running", stallKind: null }), 999_999_999), { kind: "drop" });
});

test("情境：恢復探測連續失敗到上限 → exhausted 降級告知，不靜默續等", () => {
  const tracker = new UsageRetryTracker();
  tracker.note("task-1", "decide", 0);
  const decideView = () => view({ stallKind: usageStallKind("decide") });
  let now = 0;
  for (let round = 1; round <= USAGE_RETRY_MAX_PROBES; round += 1) {
    now += USAGE_RETRY_MAX_COOLDOWN_MS; // 跳過退避
    const action = usageRetryAction(tracker, "task-1", decideView(), now);
    assert.equal(action.kind, "probe");
    assert.equal(action.kind === "probe" && action.probe, round);
    // 探測後仍受限：呼叫端不動作，計數已在 beginProbe 記下
  }
  now += USAGE_RETRY_MAX_COOLDOWN_MS;
  assert.deepEqual(usageRetryAction(tracker, "task-1", decideView(), now), { kind: "exhausted" });
  // 呼叫端 resolve 後不再追蹤；使用者手動回覆再受限會重新登記、次數重新起算
  tracker.resolve("task-1");
  assert.equal(tracker.size, 0);
  tracker.note("task-1", "decide", now);
  assert.equal(tracker.get("task-1")?.probes, 0);
});

test("stall 標記換人（別的失敗接手）或任務推進 → drop 作廢，不與其他引擎互踩", () => {
  const tracker = new UsageRetryTracker();
  tracker.note("task-1", "dedicated", 0);
  const later = USAGE_RETRY_BASE_COOLDOWN_MS;
  // 恢復重跑後改成「建立失敗」（bossDeptCreateRetry 的命名空間）→ 本登記作廢
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ stallKind: "dept_create:dedicated" }), later), { kind: "drop" });
  // 中央護欄清掉 stall（error 被別的路徑改寫、或標記已失效）→ 作廢
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ stallKind: null }), later), { kind: "drop" });
  // 同引擎但不同入口的標記也不認
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ stallKind: usageStallKind("decide") }), later), { kind: "drop" });
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ status: "cancelled" }), later), { kind: "drop" });
  // 未登記的一律 drop
  assert.deepEqual(usageRetryAction(tracker, "ghost", view(), later), { kind: "drop" });
});

test("再受限（note 既有條目）不重置次數，kind 以最新為準", () => {
  const tracker = new UsageRetryTracker();
  tracker.note("task-1", "decide", 0);
  tracker.beginProbe("task-1", USAGE_RETRY_BASE_COOLDOWN_MS);
  tracker.note("task-1", "dedicated", 500_000);
  const entry = tracker.get("task-1");
  assert.equal(entry?.probes, 1); // 不歸零
  assert.equal(entry?.kind, "dedicated");
  // 舊入口的標記 → drop；新入口的標記 → 依退避決定
  assert.deepEqual(usageRetryAction(tracker, "task-1", view({ stallKind: usageStallKind("decide") }), 999_999_999), { kind: "drop" });
  const action = usageRetryAction(tracker, "task-1", view(), 500_000 + usageRetryBackoffMs(1));
  assert.equal(action.kind, "probe");
});
