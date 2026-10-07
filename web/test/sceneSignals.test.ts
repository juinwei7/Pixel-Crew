import assert from "node:assert/strict";
import test from "node:test";
import {
  completionTier,
  finalTrigger,
  handoffBatons,
  heldStation,
  missionBatons,
  planPaper,
  PLAN_BAR_PX,
  TOOL_GAP_HOLD_MS,
  TURN_END_HOLD_MS,
  type SceneMissionStep,
} from "../src/game/sceneSignals";
import type { CharacterState } from "../src/types";

function char(patch: Partial<CharacterState> = {}): CharacterState {
  return { activity: "idle", mood: "neutral", station: "home", speech: "", bump: 0, ...patch };
}

test("completionTier: tool results are the small tier, turn ends the big one, no bump = nothing", () => {
  const prev = char({ bump: 1 });
  assert.equal(completionTier(null, char({ bump: 2, mood: "success" })), "none");
  assert.equal(completionTier(prev, char({ bump: 1, mood: "success" })), "none");
  assert.equal(completionTier(prev, char({ bump: 2, mood: "neutral" })), "none");
  assert.equal(completionTier(prev, char({ bump: 2, mood: "success", outcome: "tool" })), "tool-ok");
  assert.equal(completionTier(prev, char({ bump: 2, mood: "error", outcome: "tool" })), "tool-fail");
  assert.equal(completionTier(prev, char({ bump: 2, mood: "success", outcome: "turn" })), "turn-ok");
  assert.equal(completionTier(prev, char({ bump: 2, mood: "error", outcome: "turn" })), "turn-fail");
  // Legacy data without outcome behaves like a turn end.
  assert.equal(completionTier(prev, char({ bump: 2, mood: "success" })), "turn-ok");
});

test("heldStation: a tool station going home is held, then released", () => {
  const between = char({ station: "home", activity: "thinking" });
  const first = heldStation("code", between, null, 1_000);
  assert.equal(first.station, "code");
  assert.deepEqual(first.hold, { station: "code", until: 1_000 + TOOL_GAP_HOLD_MS });
  // Still within the window: the same hold object comes back.
  const mid = heldStation("code", between, first.hold, 3_000);
  assert.equal(mid.station, "code");
  assert.equal(mid.hold, first.hold);
  // Window over: home.
  assert.deepEqual(heldStation("code", between, first.hold, 1_000 + TOOL_GAP_HOLD_MS), { station: "home", hold: null });
});

test("heldStation: the next tool anywhere clears the hold; home and meeting are never held", () => {
  const hold = { station: "code" as const, until: 9_000 };
  assert.deepEqual(heldStation("code", char({ station: "web", activity: "working" }), hold, 2_000), { station: "web", hold: null });
  assert.deepEqual(heldStation("code", char({ station: "code", activity: "working" }), hold, 2_000), { station: "code", hold: null });
  assert.deepEqual(heldStation("home", char(), null, 0), { station: "home", hold: null });
  assert.deepEqual(heldStation("meeting", char(), null, 0), { station: "home", hold: null });
  assert.deepEqual(heldStation(null, char(), null, 0), { station: "home", hold: null });
});

test("heldStation: a turn end only lingers briefly, and shortens a running gap hold", () => {
  const ended = char({ station: "home", mood: "success", outcome: "turn", bump: 3 });
  assert.deepEqual(heldStation("terminal", ended, null, 500).hold, { station: "terminal", until: 500 + TURN_END_HOLD_MS });
  const gap = { station: "terminal" as const, until: 500 + TOOL_GAP_HOLD_MS };
  assert.deepEqual(heldStation("terminal", ended, gap, 1_000).hold, { station: "terminal", until: 1_000 + TURN_END_HOLD_MS });
  // A new turn starting (neutral mood) doesn't stretch it again.
  const short = { station: "terminal" as const, until: 2_000 };
  assert.equal(heldStation("terminal", char({ activity: "thinking" }), short, 1_500).hold, short);
});

type W = Parameters<typeof handoffBatons>[1][number];
const src = (stage: W["handoffStage"]): W => ({ id: "a", handoffStage: stage, collaborationRole: "source", collaborationPartnerId: "b" });
const tgt = (stage: W["handoffStage"]): W => ({ id: "b", handoffStage: stage, collaborationRole: "target", collaborationPartnerId: "a" });

test("handoffBatons: entering outbound passes source to target once, inbound passes it back", () => {
  const first = handoffBatons(new Map(), [src("outbound"), tgt("outbound")]);
  assert.deepEqual(first.passes, [{ from: "a", to: "b" }]);
  assert.deepEqual([...first.seen], [["a>b", "outbound"]]);
  const again = handoffBatons(first.seen, [src("outbound"), tgt("outbound")]);
  assert.deepEqual(again.passes, []);
  const working = handoffBatons(again.seen, [src("working"), tgt("working")]);
  assert.deepEqual(working.passes, []);
  const back = handoffBatons(working.seen, [src("inbound"), tgt("inbound")]);
  assert.deepEqual(back.passes, [{ from: "b", to: "a" }]);
});

test("handoffBatons: needs both ends on screen, and works with the stage on one side only", () => {
  assert.deepEqual(handoffBatons(new Map(), [src("outbound")]).passes, []);
  assert.deepEqual(handoffBatons(new Map(), [src(null), tgt("outbound")]).passes, [{ from: "a", to: "b" }]);
  assert.equal(handoffBatons(new Map(), [{ id: "a" }, { id: "b" }]).seen.size, 0);
});

function step(missionId: string, assigneeId: string, index = 0): SceneMissionStep {
  return { missionId, index, total: 3, kind: "execute", assigneeId, status: "running" };
}

test("missionBatons: a step changing hands passes the baton; first sight only records", () => {
  const first = missionBatons(new Map(), [{ id: "a", missionStep: step("m1", "a") }, { id: "b", missionStep: step("m1", "a") }]);
  assert.deepEqual(first.passes, []);
  assert.equal(first.seen.get("m1"), "a");
  const next = missionBatons(first.seen, [{ id: "a", missionStep: step("m1", "b", 1) }, { id: "b", missionStep: step("m1", "b", 1) }]);
  assert.deepEqual(next.passes, [{ from: "a", to: "b" }]);
  // Same assignee for the next step: no pass. New assignee not on screen: no pass.
  assert.deepEqual(missionBatons(next.seen, [{ id: "b", missionStep: step("m1", "b", 2) }]).passes, []);
  assert.deepEqual(missionBatons(next.seen, [{ id: "c", missionStep: step("m1", "c", 2) }]).passes, []);
});

test("planPaper: progress bar cells, visible once started, never full before done", () => {
  assert.equal(planPaper(null), null);
  assert.equal(planPaper({ done: 0, total: 0 }), null);
  assert.deepEqual(planPaper({ done: 0, total: 5 }), { filled: 0, complete: false });
  assert.deepEqual(planPaper({ done: 1, total: 20 }), { filled: 1, complete: false });
  assert.deepEqual(planPaper({ done: 19, total: 20 }), { filled: PLAN_BAR_PX - 1, complete: false });
  assert.deepEqual(planPaper({ done: 2, total: 4 }), { filled: 2, complete: false });
  assert.deepEqual(planPaper({ done: 4, total: 4 }), { filled: PLAN_BAR_PX, complete: true });
  assert.deepEqual(planPaper({ done: 9, total: 4 }), { filled: PLAN_BAR_PX, complete: true });
});

test("finalTrigger: first sight is the baseline, each new nonce fires once, never replays", () => {
  const base = finalTrigger(null, ["turn:a", "mission:m1"]);
  assert.equal(base.fresh, false);
  assert.equal(finalTrigger(base.seen, ["turn:a", "mission:m1"]).fresh, false);
  const fresh = finalTrigger(base.seen, ["turn:b", "mission:m1"]);
  assert.equal(fresh.fresh, true);
  assert.equal(finalTrigger(fresh.seen, ["turn:b"]).fresh, false);
  // Dropped out of the list and back again: still seen.
  assert.equal(finalTrigger(fresh.seen, ["turn:a"]).fresh, false);
  assert.equal(finalTrigger(null, undefined).fresh, false);
  assert.equal(finalTrigger(new Set(), []).fresh, false);
});
