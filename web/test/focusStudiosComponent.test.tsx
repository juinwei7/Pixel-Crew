import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusStudios } from "../src/components/FocusStudios";

test("renders accessible managed-workspace controls for Focus Reader", () => {
  const html = renderToStaticMarkup(<FocusStudios
    activeWorkspace="/repo/api"
    collapsed={false}
    onCollapsedChange={() => {}}
    onSelect={() => {}}
    onCreateNpc={() => {}}
    studios={[
      { workspacePath: "/repo/api", name: "api", workerIds: ["api-1"], busyCount: 1, attentionCount: 0, unreadCount: 0 },
      { workspacePath: "/repo/web", name: "web", workerIds: ["web-1", "web-2"], busyCount: 0, attentionCount: 1, unreadCount: 0 },
      { workspacePath: "/repo/empty", name: "empty", workerIds: [], busyCount: 0, attentionCount: 0, unreadCount: 0 },
    ]}
  />);
  assert.match(html, /STUDIOS/);
  assert.match(html, /工作室快速切換/);
  assert.match(html, /api/);
  assert.match(html, /web/);
  assert.match(html, /Alt\+1/);
  assert.match(html, /aria-label="搜尋工作室"/);
  assert.match(html, /重新整理 Git 狀態/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /讀取 Git 狀態中/);
  // 新增 NPC 是清單的第一個項目（鎖在最上面，不受搜尋篩選影響）。
  const createIndex = html.indexOf("focus-studios__create");
  const firstStudioIndex = html.indexOf("focus-studios__studio ");
  assert.ok(createIndex >= 0 && createIndex < firstStudioIndex);
});

test("renders a compact rail without hiding accessible studio names", () => {
  const html = renderToStaticMarkup(<FocusStudios
    activeWorkspace="/repo/api"
    collapsed
    onCollapsedChange={() => {}}
    onSelect={() => {}}
    onCreateNpc={() => {}}
    studios={[{ workspacePath: "/repo/api", name: "api", workerIds: ["api-1"], busyCount: 0, attentionCount: 0, unreadCount: 0 }]}
  />);
  assert.match(html, /focus-studios--collapsed/);
  assert.match(html, /展開工作室列/);
  assert.match(html, /aria-label="api/);
});

test("shows an unread badge distinct from busy/attention when a studio has unseen output", () => {
  const html = renderToStaticMarkup(<FocusStudios
    activeWorkspace="/repo/api"
    collapsed={false}
    onCollapsedChange={() => {}}
    onSelect={() => {}}
    onCreateNpc={() => {}}
    studios={[{ workspacePath: "/repo/api", name: "api", workerIds: ["api-1"], busyCount: 0, attentionCount: 0, unreadCount: 2 }]}
  />);
  assert.match(html, /未讀 2/);
  assert.match(html, /focus-studios__signal--unread/);
});

test("renders the add-NPC control with an accessible label", () => {
  const html = renderToStaticMarkup(<FocusStudios
    activeWorkspace="/repo/api"
    collapsed={false}
    onCollapsedChange={() => {}}
    onSelect={() => {}}
    onCreateNpc={() => {}}
    studios={[{ workspacePath: "/repo/api", name: "api", workerIds: ["api-1"], busyCount: 0, attentionCount: 0, unreadCount: 0 }]}
  />);
  assert.match(html, /focus-studios__create/);
  assert.match(html, /新增 NPC/);
});
