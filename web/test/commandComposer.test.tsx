import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandComposer } from "../src/components/CommandComposer";
import { emptyWorker } from "../src/workerState";

const capabilities = {
  slashCommands: [],
  mcpServers: [],
  models: [],
  toolCount: null,
  loading: false,
  source: "live" as const,
  updatedAt: null,
  error: null,
};

function render(busy: boolean, focusRequest = 0) {
  const worker = emptyWorker("worker", "小助手", null, busy, 0, "claude", "/repo");
  return renderToStaticMarkup(<CommandComposer
    active={worker}
    workers={[worker]}
    workspacePath="/repo"
    capabilities={capabilities}
    authReady
    paletteOpen={false}
    focusRequest={focusRequest}
    onPaletteOpen={() => {}}
    onSubmit={async () => null}
    onInterrupt={() => {}}
    onManage={() => {}}
  />);
}

test("keeps the composer editable while an agent is busy", () => {
  const html = render(true);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
  assert.doesNotMatch(html, /<textarea[^>]*readonly=""/);
  assert.match(html, /執勤中，可輸入或貼圖排隊/);
});

test("allows input again when the agent is idle", () => {
  const html = render(false);
  assert.doesNotMatch(html, /<textarea[^>]*readonly=""/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
});

test("marks the composer for immediate focus after an NPC click", () => {
  const html = render(false, 1);
  assert.match(html, /<textarea[^>]*autofocus=""/);
});
