import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskComposer } from "../src/components/TaskComposer";
import { dragContainsFiles } from "../src/composerDrag";
import { mergeComposerItems, moveQueuedItem, reorderQueuedItem } from "../src/composerQueue";
import { emptyWorker } from "../src/workerState";

const capabilities = {
  slashCommands: [],
  mcpServers: [],
  models: [],
  toolCount: null,
  builtinTools: null,
  loading: false,
  source: "live" as const,
  updatedAt: null,
  error: null,
};

function render(busy: boolean, focusRequest = 0, focusMode = false) {
  const worker = emptyWorker("worker", "小助手", null, busy, 0, "claude", "/repo");
  return renderToStaticMarkup(<TaskComposer
    draftKey="worker:claude:/repo"
    placeholder={busy ? "小助手 執勤中·可排隊" : "對 小助手 下指令（可附加圖片或文件）"}
    submitLabel="執行"
    disabled={false}
    layout="dock"
    focusMode={focusMode}
    focusRequest={focusRequest}
    busy={busy}
    queueEnabled
    persistExtras
    palette={{ workspacePath: "/repo", provider: "claude", capabilities, open: false, onOpenChange: () => {}, onManage: () => {} }}
    history={{ workers: [worker], provider: "claude", workspacePath: "/repo" }}
    onSubmit={async () => null}
    onInterrupt={() => {}}
  />);
}

test("keeps the composer editable while an agent is busy", () => {
  const html = render(true);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled=""/);
  assert.doesNotMatch(html, /<textarea[^>]*readonly=""/);
  assert.match(html, /執勤中·可排隊/);
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

test("dock layout keeps target context and optional controls in the unified composer", () => {
  const html = renderToStaticMarkup(<TaskComposer
    draftKey="boss:/repo:new"
    placeholder="直接交辦你想做的工作"
    submitLabel="交辦"
    layout="dock"
    leading={<span>BOSS</span>}
    toolbar={<span>進階設定</span>}
    onSubmit={async () => null}
  />);
  assert.match(html, /command-composer/);
  assert.match(html, /command-composer__toolbar/);
  assert.match(html, />BOSS</);
  assert.match(html, />進階設定</);
});

test("Department/Boss call sites render the plain inline composer unchanged", () => {
  const html = renderToStaticMarkup(<TaskComposer
    draftKey="department:eng:new"
    placeholder="直接交辦給工程部"
    submitLabel="交辦"
    busyLabel="派工中…"
    disabled={false}
    working={false}
    toolbar={<span>acceptance-criteria-toolbar</span>}
    onSubmit={async () => null}
  />);
  assert.match(html, /task-composer/);
  assert.doesNotMatch(html, /command-composer/);
  assert.doesNotMatch(html, /command-palette/);
  assert.doesNotMatch(html, /command-queue/);
  assert.match(html, /acceptance-criteria-toolbar/);
});

test("only treats native file payloads as full-surface attachment drags", () => {
  assert.equal(dragContainsFiles({ types: ["Files"] as unknown as DOMStringList }), true);
  assert.equal(dragContainsFiles({ types: ["text/plain"] as unknown as DOMStringList }), false);
  assert.equal(dragContainsFiles({ types: ["text/uri-list", "Files"] as unknown as DOMStringList }), true);
  assert.equal(dragContainsFiles(null), false);
});

test("moves queued messages without mutating the existing order", () => {
  const queue = ["first", "second", "third"];
  assert.deepEqual(moveQueuedItem(queue, 1, -1), ["second", "first", "third"]);
  assert.deepEqual(moveQueuedItem(queue, 1, 1), ["first", "third", "second"]);
  assert.equal(moveQueuedItem(queue, 0, -1), queue);
  assert.deepEqual(queue, ["first", "second", "third"]);
  assert.deepEqual(reorderQueuedItem(queue, 0, 2), ["second", "third", "first"]);
  assert.equal(reorderQueuedItem(queue, 1, 1), queue);
});

test("restored composer extras merge by id without duplicating current attachments", () => {
  const saved = [{ id: "saved", value: 1 }, { id: "same", value: 1 }];
  const current = [{ id: "same", value: 2 }, { id: "current", value: 3 }];
  assert.deepEqual(mergeComposerItems(saved, current), [
    { id: "saved", value: 1 },
    { id: "same", value: 2 },
    { id: "current", value: 3 },
  ]);
});
