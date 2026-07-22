import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CrewFilter } from "../src/uiPreferences";
import { WorkerTabs } from "../src/components/WorkerTabs";
import { emptyWorker } from "../src/workerState";
import type { Department, DepartmentMission } from "../src/types";

function renderRail(collapsed: boolean, count: number, filter: CrewFilter = "all") {
  const workers = Array.from({ length: count }, (_, index) =>
    emptyWorker(`worker-${index}`, `NPC ${index + 1}`, null, false, index, index % 2 ? "codex" : "claude", "/room"),
  );
  return renderToStaticMarkup(<WorkerTabs
    workers={workers}
    activeId={workers[0]?.id ?? null}
    currentRoom="/room"
    filter={filter}
    collapsed={collapsed}
    onFilter={() => {}}
    onCollapsed={() => {}}
    onSelect={() => {}}
    onReorder={() => {}}
    onCreate={() => {}}
    onClose={() => {}}
    onRename={async () => null}
    onAvatar={() => {}}
    onPersona={() => {}}
    onRoom={() => {}}
  />);
}

test("renders twenty stable worker selection controls without disabling the rail", () => {
  const html = renderRail(false, 20);
  assert.equal((html.match(/class="crew-row__select"/g) ?? []).length, 20);
  assert.match(html, /CREW/);
  assert.match(html, /20\/20/);
  assert.match(html, /crew-rail__add[^>]*disabled/);
});

test("collapsed rail keeps one compact add action", () => {
  const html = renderRail(true, 3);
  assert.match(html, /aria-label="新增人員"/);
  assert.match(html, /aria-label="展開人員列"/);
});

test("unfiltered rows are marked draggable with keyboard reorder shortcuts", () => {
  const html = renderRail(false, 3);
  assert.equal((html.match(/data-worker-id="/g) ?? []).length, 3);
  assert.equal((html.match(/crew-row--draggable/g) ?? []).length, 3);
  assert.equal((html.match(/aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/g) ?? []).length, 3);
});

test("filtered rail disables reordering", () => {
  const html = renderRail(false, 4, "claude");
  assert.doesNotMatch(html, /data-worker-id=/);
  assert.doesNotMatch(html, /crew-row--draggable/);
  assert.doesNotMatch(html, /aria-keyshortcuts/);
});

test("groups persisted departments independently and exposes mission progress", () => {
  const lead = emptyWorker("lead", "Lead", null, false, 0, "claude", "/shared");
  const builder = emptyWorker("builder", "Builder", null, false, 1, "codex", "/shared");
  const reviewer = emptyWorker("reviewer", "Reviewer", null, false, 2, "claude", "/shared");
  lead.departmentId = "product";
  builder.departmentId = "product";
  reviewer.departmentId = "quality";
  const departments: Department[] = [
    { id: "product", name: "產品部", purpose: "交付產品", workspacePath: "/shared", leadWorkerId: "lead", memberWorkerIds: ["lead", "builder"], createdAt: "", updatedAt: "" },
    { id: "quality", name: "品質部", purpose: "品質把關", workspacePath: "/shared", leadWorkerId: "reviewer", memberWorkerIds: ["reviewer"], createdAt: "", updatedAt: "" },
  ];
  const mission: DepartmentMission = {
    id: "mission", departmentId: "product", workspacePath: "/shared", bossWorkerId: "lead", objective: "Ship", acceptanceCriteria: [], status: "executing", planSummary: null,
    steps: [
      { id: "one", title: "Build", objective: "Build", kind: "execute", assigneeWorkerId: "builder", acceptanceCriteria: [], status: "completed", attempt: 1, result: "done", reviewResult: null, startedAt: null, completedAt: null },
      { id: "two", title: "Review", objective: "Review", kind: "review", assigneeWorkerId: "lead", acceptanceCriteria: [], status: "running", attempt: 1, result: null, reviewResult: null, startedAt: null, completedAt: null },
    ],
    currentStepIndex: 1, correctionCount: 0, maxCorrections: 2, error: null, createdAt: "", startedAt: null, completedAt: null,
  };
  const html = renderToStaticMarkup(<WorkerTabs workers={[lead, builder, reviewer]} departments={departments} missions={[mission]} selectedDepartmentId="product" activeId="lead" currentRoom="/shared" filter="all" collapsed={false}
    onFilter={() => {}} onCollapsed={() => {}} onSelect={() => {}} onSelectDepartment={() => {}} onReorder={() => {}} onCreate={() => {}} onClose={() => {}} onRename={async () => null} onAvatar={() => {}} onPersona={() => {}} onRoom={() => {}} />);
  assert.match(html, /crew-department--active/);
  assert.match(html, /產品部/);
  assert.match(html, /品質部/);
  assert.match(html, /2 位 NPC/);
  assert.match(html, /1\/2/);
  assert.equal((html.match(/class="crew-department /g) ?? []).length, 2);
  assert.doesNotMatch(html, /crew-row--active/);
});
