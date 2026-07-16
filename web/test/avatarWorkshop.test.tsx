import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarWorkshop } from "../src/components/AvatarWorkshop";
import type { WorkerState } from "../src/types";

const worker: WorkerState = {
  id: "worker-1",
  name: "小助手",
  model: null,
  busy: false,
  colorIndex: 0,
  avatarId: "b3bb8e8a-4040-4e89-9bb7-c64fb4b7943b.gif",
  avatarKind: "custom",
  avatarPresetId: "classic",
  provider: "codex",
  workspacePath: "/tmp/project",
  turns: [],
  character: { activity: "idle", mood: "neutral", station: "desk", speech: "", bump: 0 },
  subagents: [],
  meta: null,
  keyCounter: 0,
  openTextKey: null,
  openThinkingKey: null,
};

test("shows GIF playback information without static-image adjustment controls", () => {
  const html = renderToStaticMarkup(
    <AvatarWorkshop worker={worker} onSave={async () => null} onPreset={async () => null} onActivateCustom={async () => null} onReset={async () => null} onClose={() => undefined} />,
  );
  assert.match(html, /保留原始動畫/);
  assert.match(html, /320 × 320/);
  assert.match(html, /120 幀/);
  assert.doesNotMatch(html, /type="range"/);
});

test("keeps adjustment controls for a static custom avatar", () => {
  const html = renderToStaticMarkup(
    <AvatarWorkshop worker={{ ...worker, avatarId: worker.avatarId!.replace(".gif", ".png") }} onSave={async () => null} onPreset={async () => null} onActivateCustom={async () => null} onReset={async () => null} onClose={() => undefined} />,
  );
  assert.match(html, /type="range"/);
  assert.match(html, /縮放/);
});

test("shows five official animated presets in the official source tab", () => {
  const html = renderToStaticMarkup(
    <AvatarWorkshop worker={{ ...worker, avatarKind: "preset", avatarPresetId: "signal" }} onSave={async () => null} onPreset={async () => null} onActivateCustom={async () => null} onReset={async () => null} onClose={() => undefined} />,
  );
  assert.match(html, /官方角色/);
  assert.match(html, /經典隊員/);
  assert.match(html, /霓虹工程師/);
  assert.match(html, /訊號分析師/);
  assert.match(html, /火花設計師/);
  assert.match(html, /夜班維運/);
  assert.match(html, /每一位都保留走路、工作與歡呼動畫/);
});
