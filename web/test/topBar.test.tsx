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
    onAutoApprove={() => {}}
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
    onAutoApprove={() => {}}
    onRefreshAuth={() => {}}
    onResetUi={() => {}}
  />);
  assert.match(html, /Sonnet/);
  assert.match(html, /正在背景更新模型/);
  assert.doesNotMatch(html, /aria-label="選擇模型" disabled/);
});

test("shows the auto-approve toggle for Claude and reflects the worker's current setting", () => {
  const commonProps = {
    activeWorkspace: "/repo/my-room",
    capabilities: { slashCommands: [], mcpServers: [], models: [], toolCount: null, loading: false, source: "live" as const, updatedAt: null, error: null },
    auth: { provider: "claude" as const, displayName: "Claude Code", status: "authenticated" as const, loginCommand: "claude", checkedAt: null, error: null },
    wsReady: true,
    modelOptions: [{ id: "sonnet", label: "Sonnet" }],
    workerCount: 1,
    onRoom: () => {},
    onProvider: () => {},
    onModel: () => {},
    onAutoApprove: () => {},
    onRefreshAuth: () => {},
    onResetUi: () => {},
  };

  const off = emptyWorker("worker", "Ada", "sonnet", false, 0, "claude", "/repo/my-room");
  const offHtml = renderToStaticMarkup(<TopBar {...commonProps} active={off} />);
  assert.match(offHtml, /安全自動核准/);
  assert.match(offHtml, /top-bar__auto-approve--off/);
  assert.match(offHtml, /<option value="off" selected="">/);

  const safe = { ...off, autoApproveMode: "safe" as const };
  const safeHtml = renderToStaticMarkup(<TopBar {...commonProps} active={safe} />);
  assert.match(safeHtml, /top-bar__auto-approve--safe/);
  assert.match(safeHtml, /<option value="safe" selected="">/);

  const full = { ...off, autoApproveMode: "full" as const };
  const fullHtml = renderToStaticMarkup(<TopBar {...commonProps} active={full} />);
  assert.match(fullHtml, /top-bar__auto-approve--full/);
  assert.match(fullHtml, /<option value="full" selected="">/);
});

test("also shows the auto-approve control for Codex", () => {
  const off = emptyWorker("worker", "Ada", null, false, 0, "codex", "/repo/my-room");
  const html = renderToStaticMarkup(<TopBar
    active={off}
    activeWorkspace="/repo/my-room"
    capabilities={{ slashCommands: [], mcpServers: [], models: [], toolCount: null, loading: false, source: "live", updatedAt: null, error: null }}
    auth={{ provider: "codex", displayName: "Codex", status: "authenticated", loginCommand: "codex", checkedAt: null, error: null }}
    wsReady
    modelOptions={[]}
    workerCount={1}
    onRoom={() => {}}
    onProvider={() => {}}
    onModel={() => {}}
    onAutoApprove={() => {}}
    onRefreshAuth={() => {}}
    onResetUi={() => {}}
  />);
  assert.match(html, /安全自動核准/);
  assert.match(html, /top-bar__auto-approve--off/);
});
