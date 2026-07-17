import assert from "node:assert/strict";
import test from "node:test";
import { diffNotifications, snapshotWorker } from "../src/notifications";
import { milestoneLevel } from "../src/milestones";
import { emptyWorker } from "../src/workerState";
import type { ApprovalDecision, Turn, WorkerState } from "../src/types";

function approvalTurn(id: string, decisions: ApprovalDecision[] = ["allow_once", "deny"]): Turn {
  return {
    key: "turn-live",
    command: "安裝依賴",
    status: "running",
    items: [{
      kind: "approval",
      key: "approval",
      status: "pending",
      request: {
        id,
        activityId: "cmd",
        category: "command",
        title: "允許執行 npm install？",
        input: { command: "npm install" },
        command: "npm install",
        cwd: "/repo",
        decisions,
      },
    }],
  };
}

function doneTurn(status: "done" | "error"): Turn {
  return { key: "turn-1", command: "跑測試", status, items: [] };
}

function snap(workers: WorkerState[]): Map<string, ReturnType<typeof snapshotWorker>> {
  return new Map(workers.map((worker) => [worker.id, snapshotWorker(worker)]));
}

test("a newly appeared approval notifies once and only once", () => {
  const idle = emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo");
  const withApproval = { ...idle, turns: [approvalTurn("a-1")] };

  const events = diffNotifications(snap([idle]), [withApproval]);
  assert.equal(events.length, 1);
  assert.match(events[0].title, /小助手 等待核准/);
  assert.match(events[0].body, /npm install/);

  // Same approval still pending on the next diff → no duplicate.
  assert.equal(diffNotifications(snap([withApproval]), [withApproval]).length, 0);
});

test("busy→idle transition notifies task completion or failure by turn status", () => {
  const busy = emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo");
  const done = { ...emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo"), turns: [doneTurn("done")] };
  const failed = { ...emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo"), turns: [doneTurn("error")] };

  const okEvents = diffNotifications(snap([busy]), [done]);
  assert.equal(okEvents.length, 1);
  assert.match(okEvents[0].title, /完成任務/);

  const failEvents = diffNotifications(snap([busy]), [failed]);
  assert.match(failEvents[0].title, /任務失敗/);

  // Still busy → nothing yet.
  assert.equal(diffNotifications(snap([busy]), [busy]).length, 0);
});

test("first sight of a worker only establishes a baseline", () => {
  const withApproval = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [approvalTurn("a-1")] };
  assert.equal(diffNotifications(new Map(), [withApproval]).length, 0);
});

test("milestone levels unlock at 25 / 100 / 300 completed turns", () => {
  assert.equal(milestoneLevel(0), 0);
  assert.equal(milestoneLevel(24), 0);
  assert.equal(milestoneLevel(25), 1);
  assert.equal(milestoneLevel(99), 1);
  assert.equal(milestoneLevel(100), 2);
  assert.equal(milestoneLevel(300), 3);
  assert.equal(milestoneLevel(9999), 3);
});
