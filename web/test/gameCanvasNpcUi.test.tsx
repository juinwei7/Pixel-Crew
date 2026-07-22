import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GameCanvas, groupWorkersByWorkspace, radialMenuDirection } from "../src/components/GameCanvas";
import { DEPARTMENT_SEAT_COLUMNS, departmentDeskLayout, type PersonalDeskState } from "../src/game/personalDesks";
import { emptyWorker } from "../src/workerState";
import type { ApprovalDecision, DepartmentMission, Turn } from "../src/types";

function pendingApprovalTurn(decisions: ApprovalDecision[]): Turn {
  return {
    key: "turn-live",
    command: "安裝依賴",
    status: "running",
    items: [{
      kind: "approval",
      key: "approval",
      status: "pending",
      request: {
        id: "approval-1",
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

test("shows the NPC's persona role as a persistent badge on the nameplate", () => {
  const withRole = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo", null, { role: "前端 QA", instructions: "" });
  const html = renderToStaticMarkup(
    <GameCanvas workers={[withRole]} activeId="w1" onSelect={() => {}} />,
  );
  assert.match(html, /npc-nameplate__role/);
  assert.match(html, /前端 QA/);
});

test("omits the role badge entirely when the NPC has no persona", () => {
  const noRole = emptyWorker("w1", "六號機", null, false, 0, "codex", "/repo");
  const html = renderToStaticMarkup(
    <GameCanvas workers={[noRole]} activeId="w1" onSelect={() => {}} />,
  );
  assert.doesNotMatch(html, /npc-nameplate__role/);
});

test("shows a floating approve/deny bar on the sprite for a pending approval, right on the canvas", () => {
  const worker = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [pendingApprovalTurn(["allow_once", "allow_session", "deny"])] };
  const html = renderToStaticMarkup(
    <GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} onResolveApproval={async () => null} />,
  );
  assert.match(html, /npc-approval-bar/);
  assert.match(html, /允許執行 npm install？/);
  assert.match(html, /拒絕/);
  assert.match(html, /本次皆允許/);
});

test("omits the allow-for-session button when the request doesn't offer it", () => {
  const worker = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [pendingApprovalTurn(["allow_once", "deny"])] };
  const html = renderToStaticMarkup(
    <GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} onResolveApproval={async () => null} />,
  );
  assert.match(html, /npc-approval-bar/);
  assert.doesNotMatch(html, /本次皆允許/);
});

test("never shows the approval bar when onResolveApproval isn't wired up", () => {
  const worker = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [pendingApprovalTurn(["allow_once", "deny"])] };
  const html = renderToStaticMarkup(<GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} />);
  assert.doesNotMatch(html, /npc-approval-bar/);
});

test("groups same-workspace NPCs together while preserving order inside each squad", () => {
  const a1 = emptyWorker("a1", "A1", null, false, 0, "claude", "/a");
  const b1 = emptyWorker("b1", "B1", null, false, 1, "codex", "/b");
  const a2 = emptyWorker("a2", "A2", null, false, 2, "codex", "/a");
  const b2 = emptyWorker("b2", "B2", null, false, 3, "claude", "/b");
  assert.deepEqual(groupWorkersByWorkspace([a1, b1, a2, b2]).map((worker) => worker.id), ["a1", "a2", "b1", "b2"]);
});

test("keeps persisted departments separate even when they share one workspace", () => {
  const a1 = { ...emptyWorker("a1", "A1", null, false, 0, "claude", "/repo"), departmentId: "dept-a" };
  const b1 = { ...emptyWorker("b1", "B1", null, false, 1, "claude", "/repo"), departmentId: "dept-b" };
  const a2 = { ...emptyWorker("a2", "A2", null, false, 2, "claude", "/repo"), departmentId: "dept-a" };
  assert.deepEqual(groupWorkersByWorkspace([a1, b1, a2]).map((worker) => worker.id), ["a1", "a2", "b1"]);
});

test("opens radial actions outward while guarding both viewport edges", () => {
  assert.equal(radialMenuDirection(40, 1_000), "right");
  assert.equal(radialMenuDirection(300, 1_000), "left");
  assert.equal(radialMenuDirection(700, 1_000), "right");
  assert.equal(radialMenuDirection(960, 1_000), "left");
});

function deskWorker(id: string, workspacePath: string, phase: PersonalDeskState["collaborationPhase"] = null): PersonalDeskState {
  return {
    id,
    name: id,
    colorIndex: 0,
    active: false,
    workspacePath,
    workspaceLabel: workspacePath.slice(1) || "root",
    collaborationPhase: phase,
  };
}

test("lays out a workspace as a department with one connected row bench", () => {
  const layout = departmentDeskLayout([
    deskWorker("boss", "/repo"),
    deskWorker("reviewer", "/repo", "reviewing"),
    deskWorker("solo", "/other"),
  ]);
  assert.equal(layout.departments.length, 2);
  const department = layout.departments[0];
  assert.equal(department.memberCount, 2);
  assert.equal(department.phase, "reviewing");
  assert.equal(department.segments.length, 1);
  assert.ok(department.segments[0].right - department.segments[0].left > 63);
  assert.equal(layout.departments[1].memberCount, 1);
  assert.equal(layout.departments[0].kind, "department");
  assert.equal(layout.departments[1].kind, "personal");
});

test("the expanded office grid fits eighteen permanent desks in three rows", () => {
  const workers = Array.from({ length: 18 }, (_, index) => deskWorker(`w${index}`, "/repo"));
  const rows = new Set([...departmentDeskLayout(workers).seats.values()].map((seat) => seat.row));
  assert.equal(DEPARTMENT_SEAT_COLUMNS, 6);
  assert.deepEqual([...rows], [0, 1, 2]);
});

test("keeps a walkway gap between neighbouring departments on the same row", () => {
  const layout = departmentDeskLayout([
    deskWorker("a1", "/a"), deskWorker("a2", "/a"), deskWorker("a3", "/a"),
    deskWorker("b1", "/b"), deskWorker("b2", "/b"), deskWorker("b3", "/b"),
  ]);
  const [a, b] = layout.departments;
  assert.equal(a.segments[0].row, b.segments[0].row);
  assert.ok(b.segments[0].left - a.segments[0].right >= 8, "departments must not touch");
});

test("wraps a whole department to the next row instead of splitting it mid-row", () => {
  const layout = departmentDeskLayout([
    deskWorker("a1", "/a"), deskWorker("a2", "/a"),
    deskWorker("b1", "/b"), deskWorker("b2", "/b"),
    deskWorker("c1", "/c"), deskWorker("c2", "/c"), deskWorker("c3", "/c"), deskWorker("c4", "/c"),
  ]);
  const c = layout.departments[2];
  assert.equal(c.segments.length, 1, "department /c must stay in one segment");
  const cRows = new Set(["c1", "c2", "c3", "c4"].map((id) => layout.seats.get(id)?.row));
  assert.deepEqual([...cRows], [1]);
});

test("packs four departments without mixing seats, overlaps, or active phases", () => {
  const layout = departmentDeskLayout([
    deskWorker("design-1", "/design", "planning"),
    deskWorker("design-2", "/design"),
    deskWorker("design-3", "/design"),
    deskWorker("backend-1", "/backend"),
    deskWorker("backend-2", "/backend", "executing"),
    deskWorker("qa-1", "/qa", "mission_review"),
    deskWorker("qa-2", "/qa"),
    deskWorker("qa-3", "/qa"),
    deskWorker("qa-4", "/qa"),
    deskWorker("ops-1", "/ops"),
  ]);

  assert.deepEqual(
    layout.departments.map((department) => [department.workspacePath, department.memberCount, department.kind, department.phase]),
    [
      ["/design", 3, "department", "planning"],
      ["/backend", 2, "department", "executing"],
      ["/qa", 4, "department", "mission_review"],
      ["/ops", 1, "personal", null],
    ],
  );
  assert.equal(layout.seats.size, 10);

  for (const department of layout.departments) {
    for (const [id, seat] of layout.seats) {
      if (!id.startsWith(`${department.workspaceLabel}-`)) continue;
      const segment = department.segments.find((candidate) => candidate.row === seat.row);
      assert.ok(segment, `${id} must stay inside its own department row`);
      assert.ok(seat.x >= segment.left && seat.x <= segment.right, `${id} must stay inside its own department zone`);
    }
  }

  const segments = layout.departments.flatMap((department) => department.segments);
  for (let index = 0; index < segments.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < segments.length; otherIndex += 1) {
      const a = segments[index];
      const b = segments[otherIndex];
      if (a.row !== b.row) continue;
      assert.ok(a.right + 8 <= b.left || b.right + 8 <= a.left, "department zones on the same row must keep a walkway");
    }
  }
});

test("renders collaboration status without floating squad labels or arrow connectors", () => {
  const boss = emptyWorker("boss", "BOSS", null, true, 0, "claude", "/repo");
  const reviewer = emptyWorker("reviewer", "Reviewer", null, true, 1, "codex", "/repo");
  const html = renderToStaticMarkup(<GameCanvas
    workers={[boss, reviewer]} activeId="boss" onSelect={() => {}}
    collaborations={[{
      id: "task", sourceWorkerId: "boss", targetWorkerId: "reviewer", workspacePath: "/repo",
      mode: "review", objective: "Review", acceptanceCriteria: [], status: "returning", result: null,
      continuationResult: null, error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null,
      completedAt: null, adoptedAt: "2026-07-22T00:01:00Z", handledAt: null,
    }]}
  />);
  assert.doesNotMatch(html, /workspace-squad-label/);
  assert.doesNotMatch(html, /collaboration-connector/);
  assert.doesNotMatch(html, /[←→]/);
  assert.match(html, /接續完成中/);
  assert.match(html, /結果已交回/);
});

test("renders the active Department Mission step on its assignee without connector lines", () => {
  const boss = emptyWorker("boss", "BOSS", null, false, 0, "claude", "/repo");
  const builder = emptyWorker("builder", "Builder", null, true, 1, "codex", "/repo");
  const mission: DepartmentMission = {
    id: "mission", workspacePath: "/repo", bossWorkerId: "boss", objective: "Build missions", acceptanceCriteria: [],
    status: "executing", planSummary: "Build then review", currentStepIndex: 0, correctionCount: 0, maxCorrections: 2,
    error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: null, completedAt: null,
    steps: [{ id: "step", title: "Implement API", objective: "Build it", kind: "execute", assigneeWorkerId: "builder", acceptanceCriteria: [], status: "running", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null }],
  };
  const html = renderToStaticMarkup(<GameCanvas workers={[boss, builder]} activeId="boss" onSelect={() => {}} missions={[mission]} />);
  assert.match(html, /部門工作/);
  assert.match(html, /MISSION · Implement API/);
  assert.doesNotMatch(html, /collaboration-connector/);
});
