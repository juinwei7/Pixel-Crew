import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePicker } from "../src/components/WorkspacePicker";

const common = {
  currentPath: "/Users/wei/Pixel Crew Workspace",
  recentPaths: [] as string[],
  resetsConversation: false,
  onClose: () => {},
  onSelect: async () => null,
  onBrowse: async () => ({ canceled: true }),
};

test("first launch lets a non-technical user begin immediately without choosing a project", () => {
  const html = renderToStaticMarkup(<WorkspacePicker {...common} required />);
  assert.match(html, /準備開始，想處理什麼？/);
  assert.match(html, /你不需要先準備專案/);
  assert.match(html, /直接開始/);
  assert.match(html, /我要處理現有專案/);
  assert.match(html, /進階：直接輸入專案位置/);
  assert.doesNotMatch(html, /aria-label="關閉"/);
  assert.doesNotMatch(html, />取消</);
});

test("normal room switching remains dismissible", () => {
  const html = renderToStaticMarkup(<WorkspacePicker {...common} />);
  assert.match(html, /選擇工作位置/);
  assert.match(html, /aria-label="關閉"/);
  assert.doesNotMatch(html, /FIRST ROOM SETUP/);
});

test("new NPC flow asks for a workspace before creating the station", () => {
  const html = renderToStaticMarkup(<WorkspacePicker {...common} mode="create" />);
  assert.match(html, /新 NPC 要在哪裡工作？/);
  assert.match(html, /確認後才會建立人員與工位/);
  assert.match(html, /在此建立工位/);
  assert.doesNotMatch(html, /目前 NPC 會直接搬到新位置/);
});

test("new NPC flow offers both providers and every named account", () => {
  const html = renderToStaticMarkup(<WorkspacePicker
    {...common}
    mode="create"
    newWorkerProvider="codex"
    accounts={[
      { id: "claude-work", provider: "claude", label: "工作", homeDir: "/accounts/claude", createdAt: "", updatedAt: "", auth: { provider: "claude", displayName: "Claude", status: "authenticated", loginCommand: "", checkedAt: null, error: null, debug: null } },
      { id: "codex-personal", provider: "codex", label: "個人", homeDir: "/accounts/codex", createdAt: "", updatedAt: "", auth: { provider: "codex", displayName: "Codex", status: "authenticated", loginCommand: "", checkedAt: null, error: null, debug: null } },
    ]}
  />);
  assert.match(html, /選擇 AI 帳號/);
  assert.match(html, /Claude Code · 使用共用登入/);
  assert.match(html, /Claude Code · 工作/);
  assert.match(html, /Codex · 個人/);
});
