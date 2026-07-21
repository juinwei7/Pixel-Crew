import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusControls } from "../src/components/FocusControls";
import { emptyWorker } from "../src/workerState";

const baseProps = {
  modelOptions: [{ id: "sonnet", label: "Sonnet" }],
  authReady: true,
  notificationsEnabled: false,
  onModel: () => {},
  onAutoApprove: () => {},
  onProvider: () => {},
  onRename: async () => null,
  onPersona: () => {},
  onAvatar: () => {},
  onRoom: () => {},
  onCreateNpc: () => {},
  onOpenMcp: () => {},
  onOpenBackup: () => {},
  onNotificationsToggle: () => {},
  onOpenCommandCenter: () => {},
};

test("focus controls exposes a single collapsed management trigger", () => {
  const worker = emptyWorker("worker", "Ada", "sonnet", false, 0, "claude", "/repo/my-room");
  const html = renderToStaticMarkup(<FocusControls {...baseProps} active={worker} />);
  assert.match(html, /管理/);
  assert.match(html, /aria-expanded="false"/);
  // The panel (model/auto-approve/rename/etc.) only mounts once opened, which
  // is an interactive state react-dom/server can't simulate — see topBar.test.tsx.
  assert.doesNotMatch(html, /目前 NPC/);
});

test("renders without a selected NPC without throwing", () => {
  const html = renderToStaticMarkup(<FocusControls {...baseProps} active={undefined} />);
  assert.match(html, /管理/);
});
