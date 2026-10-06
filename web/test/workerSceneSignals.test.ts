import assert from "node:assert/strict";
import test from "node:test";
import {
  collaborationStage,
  OUTBOUND_WINDOW_MS,
  isAsking,
  isFailedUnseen,
  isReplying,
  latestErrorTurnKey,
  loadSeenErrors,
  markErrorSeen,
  missionStepOf,
  planOf,
  saveSeenErrors,
  sceneSignals,
} from "../src/sceneSignals";
import { emptyWorker } from "../src/workerState";
import type { CollaborationTask, DepartmentMission, Turn, WorkerState } from "../src/types";

function turn(key: string, status: Turn["status"], extra: Partial<Turn> = {}): Turn {
  return { key, command: key, status, items: [{ kind: "assistant_text", key: `${key}-a`, text: "ok" }], ...extra };
}

function worker(patch: Partial<WorkerState> = {}): WorkerState {
  return { ...emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo"), ...patch };
}

test("latestErrorTurnKey: last real turn failing, skipping system and autopilot-ask turns", () => {
  assert.equal(latestErrorTurnKey(worker({ turns: [turn("a", "done"), turn("b", "error")] })), "b");
  assert.equal(latestErrorTurnKey(worker({ turns: [turn("a", "error"), turn("b", "done")] })), null);
  assert.equal(latestErrorTurnKey(worker({ turns: [turn("a", "error"), turn("sys", "done", { system: true })] })), "a");
  assert.equal(latestErrorTurnKey(worker({ turns: [turn("a", "error"), turn("ask", "done", { autopilotAsk: true, items: [] })] })), "a");
  // 重試中（最新回合在跑）就不算失敗。
  assert.equal(latestErrorTurnKey(worker({ turns: [turn("a", "error"), turn("b", "running")] })), null);
  assert.equal(latestErrorTurnKey(worker()), null);
});

test("isFailedUnseen clears when the NPC is selected or the error was already seen", () => {
  const failed = worker({ turns: [turn("a", "error")] });
  assert.equal(isFailedUnseen(failed, undefined, null), true);
  assert.equal(isFailedUnseen(failed, undefined, "w1"), false);
  assert.equal(isFailedUnseen(failed, "a", null), false);
  // 看過舊的失敗、又有新的失敗 → 再亮。
  const again = worker({ turns: [turn("a", "error"), turn("b", "error")] });
  assert.equal(isFailedUnseen(again, "a", null), true);
});

test("markErrorSeen records the active NPC's latest failure and prunes departed NPCs", () => {
  const seen = new Map([["gone", "x"]]);
  const workers = [worker({ turns: [turn("a", "error")] }), { ...worker({ id: "w2" }), turns: [turn("z", "error")] }];
  assert.equal(markErrorSeen(seen, workers, "w1"), true);
  assert.deepEqual([...seen], [["w1", "a"]]);
  assert.equal(markErrorSeen(seen, workers, "w1"), false);
  // 名單還沒載到時不清存檔。
  assert.equal(markErrorSeen(seen, [], null), false);
  assert.equal(seen.get("w1"), "a");
});

test("seen errors round-trip through storage and survive bad data", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  saveSeenErrors(new Map([["w1", "a"]]), storage);
  assert.deepEqual([...loadSeenErrors(storage)], [["w1", "a"]]);
  store.set("pixel-crew.failedSeen", "{not json");
  assert.equal(loadSeenErrors(storage).size, 0);
  store.set("pixel-crew.failedSeen", JSON.stringify({ w1: 3, w2: "k" }));
  assert.deepEqual([...loadSeenErrors(storage)], [["w2", "k"]]);
  assert.equal(loadSeenErrors(null).size, 0);
  assert.doesNotThrow(() => saveSeenErrors(new Map(), { setItem: () => { throw new Error("quota"); } }));
});

test("isReplying only while the open assistant text is the newest item of a running turn", () => {
  const streaming = worker({ busy: true, openTextKey: "t-a", turns: [{ ...turn("t", "running"), items: [{ kind: "assistant_text", key: "t-a", text: "hi" }] }] });
  assert.equal(isReplying(streaming), true);
  assert.equal(isReplying({ ...streaming, busy: false }), false);
  assert.equal(isReplying({ ...streaming, openTextKey: null }), false);
  const toolAfter = { ...streaming, turns: [{ ...streaming.turns[0], items: [...streaming.turns[0].items, { kind: "tool_call" as const, key: "c", id: "c", name: "Bash", input: {}, isError: false, status: "running" as const }] }] };
  assert.equal(isReplying(toolAfter), false);
});

test("isAsking: unanswered autopilot ask or the boss of a mission waiting on the owner — not tool approvals", () => {
  const approval: Turn = { ...turn("t", "running"), items: [{ kind: "approval", key: "ap", status: "pending", request: { id: "r", activityId: null, category: "command", title: "run?", input: {}, decisions: ["allow_once", "deny"] } }] };
  assert.equal(isAsking(worker({ turns: [approval] })), false);
  assert.equal(isAsking(worker({ turns: [turn("ask", "done", { autopilotAsk: true, items: [] })] })), true);
  assert.equal(isAsking(worker({ turns: [turn("ask", "done", { autopilotAsk: true, items: [] }), turn("reply", "running")] })), false);
  const stuck = { status: "needs_attention", bossWorkerId: "w1" } as DepartmentMission;
  assert.equal(isAsking(worker(), stuck), true);
  assert.equal(isAsking(worker(), { ...stuck, bossWorkerId: "w2" }), false);
  assert.equal(isAsking(worker(), { ...stuck, status: "executing" }), false);
});

test("collaborationStage: just handed out, working, handing back", () => {
  const now = Date.parse("2026-10-06T10:00:10Z");
  const collab = (status: CollaborationTask["status"], startedAt: string | null): CollaborationTask => ({
    id: "c", sourceWorkerId: "w1", targetWorkerId: "w2", workspacePath: "/repo", mode: "review" as CollaborationTask["mode"], objective: "o", acceptanceCriteria: [],
    status, result: null, continuationResult: null, error: null, createdAt: "2026-10-06T10:00:00Z", startedAt, completedAt: null, adoptedAt: null, handledAt: null,
  });
  assert.equal(collaborationStage(null, now), null);
  assert.equal(collaborationStage(collab("queued", null), now), "outbound");
  assert.equal(collaborationStage(collab("running", "2026-10-06T10:00:08Z"), now), "outbound");
  // 開始很久了（含重整後重播）＝working，不補播交棒。
  assert.equal(collaborationStage(collab("running", "2026-10-06T10:00:00Z"), now), "working");
  assert.equal(collaborationStage(collab("running", "2026-10-06T10:00:09Z"), now + OUTBOUND_WINDOW_MS), "working");
  assert.equal(collaborationStage(collab("returning", "2026-10-06T10:00:00Z"), now), "inbound");
  assert.equal(collaborationStage(collab("completed", "2026-10-06T10:00:00Z"), now), null);
});

test("planOf reads the current turn's todo list only while busy", () => {
  const todoTurn: Turn = { ...turn("t", "running"), items: [{ kind: "tool_call", key: "c", id: "c", name: "TodoWrite", input: { todos: [{ status: "completed" }, { status: "pending" }, { status: "pending" }] }, isError: false, status: "done" }] };
  assert.deepEqual(planOf(worker({ busy: true, turns: [todoTurn] })), { done: 1, total: 3 });
  assert.equal(planOf(worker({ busy: false, turns: [todoTurn] })), null);
  assert.equal(planOf(worker({ busy: true, turns: [todoTurn, turn("next", "running")] })), null);
});

test("missionStepOf describes the mission's current step and its assignee", () => {
  const mission = {
    id: "m", workspacePath: "/repo", bossWorkerId: "boss", objective: "o", acceptanceCriteria: [], status: "executing",
    planSummary: null, currentStepIndex: 1, correctionCount: 0, maxCorrections: 2, error: null, createdAt: "", startedAt: null, completedAt: null,
    steps: [
      { id: "s1", title: "調查", objective: "", kind: "execute", assigneeWorkerId: "w2", acceptanceCriteria: [], status: "completed", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null },
      { id: "s2", title: "實作", objective: "", kind: "execute", assigneeWorkerId: "w1", acceptanceCriteria: [], status: "running", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null },
    ],
  } as unknown as DepartmentMission;
  assert.deepEqual(missionStepOf(mission), { missionId: "m", index: 1, total: 2, kind: "execute", assigneeId: "w1", status: "running" });
  assert.equal(missionStepOf({ ...mission, currentStepIndex: null }), null);
  assert.equal(missionStepOf({ ...mission, currentStepIndex: 5 }), null);
  assert.equal(missionStepOf(null), null);
});

test("sceneSignals bundles every flag", () => {
  const signals = sceneSignals(worker({ turns: [turn("a", "error")] }), { activeId: null });
  assert.deepEqual(signals, { failedUnseen: true, replying: false, asking: false, handoffStage: null, plan: null, missionStep: null, finalNonces: [] });
});
