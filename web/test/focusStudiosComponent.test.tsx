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
    studios={[
      { workspacePath: "/repo/api", name: "api", workerIds: ["api-1"], busyCount: 1, attentionCount: 0 },
      { workspacePath: "/repo/web", name: "web", workerIds: ["web-1", "web-2"], busyCount: 0, attentionCount: 1 },
      { workspacePath: "/repo/empty", name: "empty", workerIds: [], busyCount: 0, attentionCount: 0 },
    ]}
  />);
  assert.match(html, /STUDIOS/);
  assert.match(html, /工作室快速切換/);
  assert.match(html, /api/);
  assert.match(html, /web/);
  assert.match(html, /Alt\+1/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /讀取 Git 狀態中/);
});

test("renders a compact rail without hiding accessible studio names", () => {
  const html = renderToStaticMarkup(<FocusStudios
    activeWorkspace="/repo/api"
    collapsed
    onCollapsedChange={() => {}}
    onSelect={() => {}}
    studios={[{ workspacePath: "/repo/api", name: "api", workerIds: ["api-1"], busyCount: 0, attentionCount: 0 }]}
  />);
  assert.match(html, /focus-studios--collapsed/);
  assert.match(html, /展開工作室列/);
  assert.match(html, /aria-label="api/);
});
