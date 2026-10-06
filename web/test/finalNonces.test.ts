import assert from "node:assert/strict";
import test from "node:test";
import { FINAL_NONCE_LIMIT, finalNoncesOf, sceneSignals } from "../src/sceneSignals";
import { emptyWorker } from "../src/workerState";
import type { BossTask, DepartmentMission, DepartmentMissionStep, Turn, TurnItem, WorkerState } from "../src/types";

function worker(patch: Partial<WorkerState> = {}): WorkerState {
  return { ...emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo"), ...patch };
}

function todo(done: number, total: number): TurnItem {
  const todos = Array.from({ length: total }, (_, i) => ({ content: `t${i}`, status: i < done ? "completed" : "pending" }));
  return { kind: "tool_call", key: `todo-${done}-${total}`, id: `todo-${done}-${total}`, name: "TodoWrite", input: { todos }, isError: false, status: "done" } as TurnItem;
}

function turn(key: string, status: Turn["status"], items: TurnItem[], extra: Partial<Turn> = {}): Turn {
  return { key, command: key, status, items, ...extra };
}

function missionStep(assigneeWorkerId: string): DepartmentMissionStep {
  return {
    id: `s-${assigneeWorkerId}`, title: "step", objective: "", kind: "execute", assigneeWorkerId, acceptanceCriteria: [],
    status: "completed", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null,
  };
}

function mission(id: string, patch: Partial<DepartmentMission> = {}): DepartmentMission {
  return {
    id, departmentId: "d1", workspacePath: "/repo", bossWorkerId: "boss", objective: "", acceptanceCriteria: [],
    status: "completed", planSummary: null, steps: [missionStep("w1")], currentStepIndex: null, correctionCount: 0,
    maxCorrections: 2, error: null, createdAt: "2026-10-01T00:00:00Z", startedAt: null, completedAt: "2026-10-01T01:00:00Z",
    ...patch,
  };
}

function bossTask(id: string, patch: Partial<BossTask> = {}): BossTask {
  return {
    id, title: id, archivedAt: null, workspacePath: "/repo", decisionProvider: "claude", decisionModel: "m", objective: "",
    acceptanceCriteria: [], status: "completed", messages: [],
    stages: [{ id: "st", departmentId: "d1", departmentName: "D", title: "", objective: "", acceptanceCriteria: [], dependsOn: [], status: "completed", missionId: null, report: null }],
    finalReport: null, error: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T02:00:00Z",
    ...patch,
  };
}

test("(a) a finished turn whose whole TodoWrite plan is completed is a final completion", () => {
  assert.deepEqual(finalNoncesOf(worker({ turns: [turn("t1", "done", [todo(3, 3)])] })), ["turn:t1"]);
  // Plan not all done, no plan, still running, or failed: stage tier only.
  assert.deepEqual(finalNoncesOf(worker({ turns: [turn("t1", "done", [todo(2, 3)])] })), []);
  assert.deepEqual(finalNoncesOf(worker({ turns: [turn("t1", "done", [])] })), []);
  assert.deepEqual(finalNoncesOf(worker({ turns: [turn("t1", "running", [todo(3, 3)])] })), []);
  assert.deepEqual(finalNoncesOf(worker({ turns: [turn("t1", "error", [todo(3, 3)])] })), []);
  // The latest list wins: an all-done list followed by a re-opened one is not done.
  assert.deepEqual(finalNoncesOf(worker({ turns: [turn("t1", "done", [todo(3, 3), todo(2, 4)])] })), []);
});

test("(a) system and autopilot-ask turns don't hide the real turn; a newer real turn replaces it", () => {
  const done = turn("t1", "done", [todo(2, 2)]);
  assert.deepEqual(finalNoncesOf(worker({ turns: [done, turn("sys", "done", [], { system: true })] })), ["turn:t1"]);
  assert.deepEqual(finalNoncesOf(worker({ turns: [done, turn("ask", "done", [], { autopilotAsk: true })] })), ["turn:t1"]);
  assert.deepEqual(finalNoncesOf(worker({ turns: [done, turn("t2", "running", [])] })), []);
});

test("(b) completed department missions count for the boss and every step assignee", () => {
  const missions = [mission("m1"), mission("m2", { status: "executing", completedAt: null })];
  assert.deepEqual(finalNoncesOf(worker({ departmentId: "d1" }), missions), ["mission:m1"]);
  assert.deepEqual(finalNoncesOf(worker({ id: "boss", departmentId: "d1" }), missions), ["mission:m1"]);
  // Same department but never part of it, or another department: no.
  assert.deepEqual(finalNoncesOf(worker({ id: "w9", departmentId: "d1" }), missions), []);
  assert.deepEqual(finalNoncesOf(worker({ departmentId: "d2" }), missions), []);
  // No department: matched by workspace.
  assert.deepEqual(finalNoncesOf(worker(), [mission("m3", { departmentId: null })]), ["mission:m3"]);
});

test("(b) only the most recent completed missions are listed, newest first", () => {
  const missions = Array.from({ length: 5 }, (_, i) => mission(`m${i}`, { completedAt: `2026-10-0${i + 1}T00:00:00Z` }));
  const out = finalNoncesOf(worker({ departmentId: "d1" }), missions);
  assert.equal(out.length, FINAL_NONCE_LIMIT);
  assert.deepEqual(out, ["mission:m4", "mission:m3", "mission:m2"]);
});

test("(c) a completed boss task counts for NPCs whose department ran one of its stages", () => {
  const tasks = [bossTask("b1"), bossTask("b2", { status: "running", completedAt: null })];
  assert.deepEqual(finalNoncesOf(worker({ departmentId: "d1" }), [], tasks), ["boss:b1"]);
  assert.deepEqual(finalNoncesOf(worker({ departmentId: "d2" }), [], tasks), []);
  assert.deepEqual(finalNoncesOf(worker(), [], tasks), []);
});

test("sceneSignals carries the final nonces (all three kinds together)", () => {
  const w = worker({ departmentId: "d1", turns: [turn("t1", "done", [todo(1, 1)])] });
  const signals = sceneSignals(w, { activeId: null, missions: [mission("m1")], bossTasks: [bossTask("b1")] });
  assert.deepEqual(signals.finalNonces, ["turn:t1", "mission:m1", "boss:b1"]);
  assert.deepEqual(sceneSignals(worker(), { activeId: null }).finalNonces, []);
});
