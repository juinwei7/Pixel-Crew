import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../src/components/TopBar";
import { emptyWorker } from "../src/workerState";

test("top bar exposes room, selected provider, model, capabilities, and health", () => {
  const worker = emptyWorker("worker", "Ada", "sonnet", false, 0, "claude", "/repo/my-room");
  const html = renderToStaticMarkup(<TopBar
    active={worker}
    activeWorkspace="/repo/my-room"
    capabilities={{ slashCommands: [], mcpServers: [{ name: "local", status: "connected" }], models: [], toolCount: 4, loading: false, source: "live", updatedAt: null, error: null }}
    auth={{ provider: "claude", displayName: "Claude Code", status: "authenticated", loginCommand: "claude", checkedAt: null, error: null }}
    wsReady
    modelOptions={[{ id: "sonnet", label: "Sonnet" }]}
    workerCount={1}
    onRoom={() => {}}
    onProvider={() => {}}
    onModel={() => {}}
    onRefreshAuth={() => {}}
    onResetUi={() => {}}
  />);
  assert.match(html, /my-room/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Sonnet/);
  assert.match(html, /MCP/);
  assert.match(html, /health-dot--ok/);
});

test("cached models remain selectable while capabilities refresh in background", () => {
  const worker = emptyWorker("worker", "Ada", "sonnet", false, 0, "claude", "/repo/my-room");
  const html = renderToStaticMarkup(<TopBar
    active={worker}
    activeWorkspace="/repo/my-room"
    capabilities={{ slashCommands: [], mcpServers: [], models: [{ id: "sonnet", label: "Sonnet" }], toolCount: null, loading: true, source: "cache", updatedAt: null, error: null }}
    auth={{ provider: "claude", displayName: "Claude Code", status: "authenticated", loginCommand: "claude", checkedAt: null, error: null }}
    wsReady
    modelOptions={[{ id: "", label: "預設模型" }, { id: "sonnet", label: "Sonnet" }]}
    workerCount={1}
    onRoom={() => {}}
    onProvider={() => {}}
    onModel={() => {}}
    onRefreshAuth={() => {}}
    onResetUi={() => {}}
  />);
  assert.match(html, /Sonnet/);
  assert.match(html, /正在背景更新模型/);
  assert.doesNotMatch(html, /aria-label="選擇模型" disabled/);
});
