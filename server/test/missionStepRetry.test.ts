import assert from "node:assert/strict";
import test from "node:test";
import { BackoffRetryTracker } from "../src/backoffRetry.js";
import {
  MISSION_STEP_RETRY_MAX_ATTEMPTS,
  MISSION_STEP_RETRY_POLICY,
  missionStepRetryAction,
  type MissionStepRetryPayload,
  type MissionStepRetryView,
} from "../src/missionStepRetry.js";

type Payload = MissionStepRetryPayload<{ verdict: string } | null>;

const PAUSED_ERROR = "小美 正在執行其他工作，請稍後重試或重新指派";

function makeTracker(): BackoffRetryTracker<Payload> {
  return new BackoffRetryTracker<Payload>(MISSION_STEP_RETRY_POLICY);
}

function payload(overrides: Partial<Payload> = {}): Payload {
  return { stepIndex: 2, assigneeWorkerId: "npc-1", pausedError: PAUSED_ERROR, priorReview: null, ...overrides };
}

function view(overrides: Partial<MissionStepRetryView> = {}): MissionStepRetryView {
  return {
    status: "needs_attention",
    attentionReason: "member_unavailable",
    error: PAUSED_ERROR,
    stepStatus: "pending",
    stepAssigneeId: "npc-1",
    assigneePresent: true,
    assigneeReady: true,
    ...overrides,
  };
}

test("mission 步驟重派：NPC 空出且退避已過 → retry 並帶回 payload", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload({ priorReview: { verdict: "changes_requested" } }), 1_000);
  const now = 1_000 + MISSION_STEP_RETRY_POLICY.baseMs;
  const action = missionStepRetryAction(tracker, "m-1", view(), now);
  assert.equal(action.kind, "retry");
  assert.equal(action.kind === "retry" && action.attempt, 1);
  assert.deepEqual(action.kind === "retry" && action.payload.priorReview, { verdict: "changes_requested" });
});

test("mission 步驟重派：首次登記也有基本退避，未到時間一律 wait", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload(), 1_000);
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view(), 1_000 + MISSION_STEP_RETRY_POLICY.baseMs - 1), { kind: "wait" });
});

test("mission 步驟重派：NPC 還在忙（或未登入）→ wait 保留追蹤且不耗次數", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload(), 1_000);
  const now = 1_000 + MISSION_STEP_RETRY_POLICY.baseMs;
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ assigneeReady: false }), now), { kind: "wait" });
  // 之後空出仍可用第 1 次重派——wait 不消耗次數。
  const action = missionStepRetryAction(tracker, "m-1", view(), now);
  assert.equal(action.kind === "retry" && action.attempt, 1);
});

test("mission 步驟重派：人工介入或狀態推進 → drop（error 改寫／狀態離開 needs_attention／步驟非 pending）", () => {
  const tracker = makeTracker();
  const now = 999_999;
  tracker.note("m-1", payload(), 0);
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ error: "老闆改了別的指示" }), now), { kind: "drop" });
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ status: "executing", error: null }), now), { kind: "drop" });
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ attentionReason: "review_inconclusive" }), now), { kind: "drop" });
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ stepStatus: "running" }), now), { kind: "drop" });
});

test("mission 步驟重派：已重新指派或 NPC 消失 → drop 留給人工", () => {
  const tracker = makeTracker();
  const now = 999_999;
  tracker.note("m-1", payload(), 0);
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ stepAssigneeId: "npc-2" }), now), { kind: "drop" });
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view({ assigneePresent: false }), now), { kind: "drop" });
});

test("mission 步驟重派：未登記的 mission → drop", () => {
  const tracker = makeTracker();
  assert.deepEqual(missionStepRetryAction(tracker, "ghost", view(), 999_999), { kind: "drop" });
});

test("mission 步驟重派：retry 當下即進退避，同輪第二次掃描只會 wait（turn_end 掃與定期掃不互踩）", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload(), 0);
  const now = MISSION_STEP_RETRY_POLICY.baseMs;
  assert.equal(missionStepRetryAction(tracker, "m-1", view(), now).kind, "retry");
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view(), now), { kind: "wait" });
});

test("mission 步驟重派：重派後又卡回來（note 既有條目）不重置次數，退避隨次數升級", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload(), 0);
  let now = MISSION_STEP_RETRY_POLICY.baseMs;
  assert.equal(missionStepRetryAction(tracker, "m-1", view(), now).kind, "retry"); // 第 1 次
  tracker.note("m-1", payload(), now); // dispatch 再度撞忙碌，pause 分支重新登記
  // attempts=1 → 退避 base×2
  assert.deepEqual(missionStepRetryAction(tracker, "m-1", view(), now + MISSION_STEP_RETRY_POLICY.baseMs * 2 - 1), { kind: "wait" });
  now += MISSION_STEP_RETRY_POLICY.baseMs * 2;
  const second = missionStepRetryAction(tracker, "m-1", view(), now);
  assert.equal(second.kind === "retry" && second.attempt, 2);
});

test("mission 步驟重派：次數用盡 → exhausted 帶回 payload 供降級文案使用", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload(), 0);
  let now = 0;
  for (let i = 1; i <= MISSION_STEP_RETRY_MAX_ATTEMPTS; i += 1) {
    now += MISSION_STEP_RETRY_POLICY.capMs;
    const action = missionStepRetryAction(tracker, "m-1", view(), now);
    assert.equal(action.kind === "retry" && action.attempt, i);
    tracker.note("m-1", payload(), now); // 每次重派後又卡回來
  }
  const action = missionStepRetryAction(tracker, "m-1", view(), now + MISSION_STEP_RETRY_POLICY.capMs * 10);
  assert.equal(action.kind, "exhausted");
  assert.equal(action.kind === "exhausted" && action.payload.stepIndex, 2);
});

test("mission 步驟重派：resolve 後視同全新登記，次數歸零", () => {
  const tracker = makeTracker();
  tracker.note("m-1", payload(), 0);
  missionStepRetryAction(tracker, "m-1", view(), MISSION_STEP_RETRY_POLICY.baseMs); // retry 第 1 次
  tracker.resolve("m-1");
  assert.equal(tracker.size, 0);
  tracker.note("m-1", payload(), 1_000_000);
  const action = missionStepRetryAction(tracker, "m-1", view(), 1_000_000 + MISSION_STEP_RETRY_POLICY.baseMs);
  assert.equal(action.kind === "retry" && action.attempt, 1);
});
