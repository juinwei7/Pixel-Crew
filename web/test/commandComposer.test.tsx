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

function render(busy: boolean, focusRequest = 0, focusMode = false) {
  const worker = emptyWorker("worker", "小助手", null, busy, 0, "claude", "/repo");
  return renderToStaticMarkup(<CommandComposer
    active={worker}
    workers={[worker]}
    workspacePath="/repo"
    capabilities={capabilities}
    authReady
    focusMode={focusMode}
    sessionKey="worker:claude:/repo"
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
  assert.match(html, /執勤中，可輸入或附加檔案排隊/);
  assert.match(html, /aria-label="附加圖片或文件"/);
});

test("allows input again when the agent is idle", () => {
  const html = render(false);
  assert.doesNotMatch(html, /<textarea[^>]*readonly=""/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
  assert.match(html, /可附加圖片或文件/);
});

test("marks the composer for immediate focus after an NPC click", () => {
  const html = render(false, 1);
  assert.match(html, /<textarea[^>]*autofocus=""/);
});

test("keeps the complete command composer available in focus mode", () => {
  const html = render(false, 0, true);
  assert.match(html, /command-composer--focus/);
  assert.match(html, /aria-label="專注模式指令輸入"/);
  assert.match(html, /data-session-key="worker:claude:\/repo"/);
  assert.match(html, /aria-label="附加圖片或文件"/);
  assert.match(html, /指令面板/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
});
