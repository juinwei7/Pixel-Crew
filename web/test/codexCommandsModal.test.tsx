import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilityState } from "../src/types";
import { CodexCommandsModal } from "../src/components/CodexCommandsModal";

function capabilities(customSlashCommands: string[]): CapabilityState {
  return {
    slashCommands: ["clear", "compact", "new", "review", ...customSlashCommands],
    customSlashCommands,
    mcpServers: [],
    models: [],
    toolCount: null,
    builtinTools: null,
    loading: false,
    source: "live",
    updatedAt: null,
    error: null,
  };
}

test("renders an accessible empty state when no custom commands exist yet", () => {
  const html = renderToStaticMarkup(<CodexCommandsModal capabilities={capabilities([])} onClose={() => {}} />);
  assert.match(html, /還沒有自訂指令/);
  assert.match(html, /aria-label="新指令名稱"/);
  assert.doesNotMatch(html, /mcp-modal__row codex-commands-modal__row/);
});

test("lists user-added commands with a remove control each, distinct from the built-in seed", () => {
  const html = renderToStaticMarkup(<CodexCommandsModal capabilities={capabilities(["goal", "plan"])} onClose={() => {}} />);
  assert.match(html, /\/goal/);
  assert.match(html, /\/plan/);
  // Built-ins are never shown as removable rows — only entries from customSlashCommands.
  assert.doesNotMatch(html, />\/clear</);
  const rowCount = html.split("codex-commands-modal__row").length - 1;
  assert.equal(rowCount, 2);
});
