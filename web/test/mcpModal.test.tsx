import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilityState, McpServerState, ProviderId } from "../src/types";
import { McpModal } from "../src/components/McpModal";

function capabilities(mcpServers: McpServerState[], overrides: Partial<CapabilityState> = {}): CapabilityState {
  return {
    slashCommands: [],
    mcpServers,
    models: [],
    toolCount: null,
    builtinTools: null,
    loading: false,
    source: "live",
    updatedAt: null,
    error: null,
    ...overrides,
  };
}

function renderModal(
  mcpServers: McpServerState[],
  provider: ProviderId = "claude",
  overrides: Partial<CapabilityState> = {},
  platform?: string,
  usedMcpTools?: Record<string, string[]>,
) {
  return renderToStaticMarkup(
    <McpModal
      capabilities={capabilities(mcpServers, overrides)}
      provider={provider}
      workspacePath="/repo"
      mcpLoginResult={null}
      platform={platform}
      usedMcpTools={usedMcpTools}
      notify={() => {}}
      onClose={() => {}}
    />,
  );
}

test("renders scope, transport, and status badges for a mixed server list", () => {
  const html = renderModal([
    { name: "my-hub", status: "connected", scope: "local", transport: "stdio", command: "python", args: ["-m", "hub"] },
    { name: "remote", status: "needs_auth", scope: "user", transport: "http", url: "https://mcp.example.com" },
    { name: "teamtool", status: "pending_approval", scope: "project", transport: "stdio" },
    { name: "claude.ai Gmail", status: "connected", scope: "account" },
  ]);

  assert.match(html, /本機（此專案私有）/);
  assert.match(html, /全域（所有專案）/);
  assert.match(html, /專案共享（\.mcp\.json）/);
  assert.match(html, /claude\.ai 帳號/);
  assert.match(html, /stdio/);
  assert.match(html, /僅能在真人互動式終端核准/);
  assert.match(html, /登入/);
  // A pending_approval server surfaces the reset-choices action for Claude.
  assert.match(html, /重設本專案核准記憶/);
});

test("offers login/logout for claude.ai account connectors (needs it most, even though their spaced names aren't removable)", () => {
  const html = renderModal([
    { name: "claude.ai Notion", status: "needs_auth", scope: "account" },
    { name: "claude.ai Gmail", status: "connected", scope: "account" },
  ]);
  // Login/logout are safe, reversible auth actions — not gated by the same
  // "editable name" rule that protects remove from touching account-level
  // connectors structurally.
  assert.match(html, /登入/);
  assert.match(html, /登出/);
  // But remove must still be absent for both (space in the name).
  assert.doesNotMatch(html, /移除/);
});

test("hides the scope badge and JSON add-mode toggle for Codex", () => {
  const html = renderModal(
    [{ name: "docs", status: "enabled", transport: "stdio", command: "npx", args: ["docs-server"] }],
    "codex",
  );
  assert.doesNotMatch(html, /mcp-modal__badge--local|mcp-modal__badge--user|mcp-modal__badge--project/);
  assert.doesNotMatch(html, /進階：貼上 JSON/);
});

test("shows the empty state when no servers are configured", () => {
  const html = renderModal([]);
  assert.match(html, /沒有設定 MCP server/);
});

test("shows a loading skeleton while capabilities are still loading with no cached servers", () => {
  const html = renderModal([], "claude", { loading: true });
  assert.match(html, /mcp-modal__skeleton/);
  assert.match(html, /讀取中…/);
});

test("an editable connected non-stdio server offers a logout action", () => {
  const html = renderModal([
    { name: "remote", status: "connected", scope: "user", transport: "http", url: "https://mcp.example.com" },
  ]);
  assert.match(html, /登出/);
});

test("gates Codex login/logout on authStatus, not the enabled/disabled status", () => {
  // Codex's `status` is about whether the server is on, not authenticated —
  // a stdio server (authStatus "unsupported") must never show login/logout,
  // even though nothing about `status` alone would rule it out.
  const html = renderModal([
    { name: "docs", status: "enabled", transport: "stdio", authStatus: "unsupported" },
    { name: "remote-unauth", status: "enabled", transport: "http", authStatus: "unauthenticated" },
    { name: "remote-auth", status: "enabled", transport: "http", authStatus: "authenticated" },
  ], "codex");

  const rowHtml = (name: string) => html.slice(html.indexOf(`>${name}<`), html.indexOf(`>${name}<`) + 900);
  assert.doesNotMatch(rowHtml("docs"), /登入|登出/);
  assert.match(rowHtml("remote-unauth"), /登入/);
  assert.doesNotMatch(rowHtml("remote-unauth"), /登出/);
  assert.match(rowHtml("remote-auth"), /登出/);
  assert.doesNotMatch(rowHtml("remote-auth"), /登入/);
});

test("labels a connected-but-tools-fetch-failed server distinctly from a healthy connection", () => {
  const html = renderModal([
    { name: "flaky", status: "connected_tools_failed", scope: "local", transport: "http", url: "https://mcp.example.com" },
  ]);
  assert.match(html, /已連線·工具清單讀取失敗/);
  assert.match(html, /mcp-modal__dot--warn/);
  assert.match(html, /可嘗試「重新讀取」或查看細節/);
  // Still authenticated in the broad sense, so logout should be offered.
  assert.match(html, /登出/);
});

test("shows the Claude Desktop import button only for Claude on macOS", () => {
  const onDarwin = renderModal([], "claude", {}, "darwin");
  assert.match(onDarwin, /從 Claude Desktop 匯入/);

  const onLinux = renderModal([], "claude", {}, "linux");
  assert.doesNotMatch(onLinux, /從 Claude Desktop 匯入/);

  const codexOnDarwin = renderModal([], "codex", {}, "darwin");
  assert.doesNotMatch(codexOnDarwin, /從 Claude Desktop 匯入/);
});

test("hides the advanced OAuth options toggle by default (stdio is the initial transport)", () => {
  // The toggle is OAuth-only and gated on transport !== "stdio"; the add
  // form's initial transport is stdio, and renderToStaticMarkup can't
  // simulate the click that would switch it — this only verifies the
  // (real, correct) hidden-by-default state, not the revealed one.
  const claudeHtml = renderModal([], "claude");
  assert.doesNotMatch(claudeHtml, /進階選項（OAuth）/);

  const codexHtml = renderModal([], "codex");
  assert.doesNotMatch(codexHtml, /進階選項（OAuth）/);
});

test("Codex server with an available tool catalog shows the count and hides the list by default", () => {
  const html = renderModal([
    { name: "my-hub", status: "enabled", toolsStatus: "available", tools: [{ name: "core_list", description: "List cores" }] },
  ], "codex");
  assert.match(html, /查看工具（1）/);
  // Collapsed by default — renderToStaticMarkup can't simulate the click.
  assert.doesNotMatch(html, /core_list/);
  assert.doesNotMatch(html, /工具清單目前無法讀取/);
});

test("Codex server without an available catalog shows the persistent unavailable note", () => {
  const errored = renderModal([{ name: "my-hub", status: "enabled", toolsStatus: "error" }], "codex");
  assert.match(errored, /工具清單目前無法讀取/);

  const neverChecked = renderModal([{ name: "my-hub", status: "enabled" }], "codex");
  assert.match(neverChecked, /工具清單目前無法讀取/);
});

test("Claude servers always show the used-tools-only fallback note, regardless of status", () => {
  const html = renderModal([{ name: "my-hub", status: "connected" }], "claude");
  assert.match(html, /僅顯示已使用過的工具/);
  assert.doesNotMatch(html, /工具清單目前無法讀取/);
});

test("a builtin Codex server shows its badge and never offers remove/login/logout", () => {
  const html = renderModal([
    { name: "codex_apps", status: "enabled", authStatus: "unauthenticated", builtin: true },
  ], "codex");
  const row = html.slice(html.indexOf(">codex_apps<"), html.indexOf(">codex_apps<") + 900);
  assert.match(row, /Codex 內建/);
  assert.doesNotMatch(row, /移除|登入|登出/);
});

test("accepts usedMcpTools for a Claude server without crashing (content is behind the collapsed toggle)", () => {
  assert.doesNotThrow(() => renderModal(
    [{ name: "my-hub", status: "connected" }],
    "claude",
    {},
    undefined,
    { "my-hub": ["core_list", "hutask_get"] },
  ));
});
