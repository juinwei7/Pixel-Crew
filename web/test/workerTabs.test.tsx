import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CrewFilter } from "../src/uiPreferences";
import { WorkerTabs } from "../src/components/WorkerTabs";
import { emptyWorker } from "../src/workerState";

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
