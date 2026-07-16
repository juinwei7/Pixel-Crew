import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerTabs } from "../src/components/WorkerTabs";
import { emptyWorker } from "../src/workerState";

function renderRail(collapsed: boolean, count: number) {
  const workers = Array.from({ length: count }, (_, index) =>
    emptyWorker(`worker-${index}`, `NPC ${index + 1}`, null, false, index, index % 2 ? "codex" : "claude", "/room"),
  );
  return renderToStaticMarkup(<WorkerTabs
    workers={workers}
    activeId={workers[0]?.id ?? null}
    currentRoom="/room"
    filter="all"
    collapsed={collapsed}
    onFilter={() => {}}
    onCollapsed={() => {}}
    onSelect={() => {}}
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
