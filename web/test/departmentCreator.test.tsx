import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DepartmentCreator } from "../src/components/DepartmentCreator";

test("department creator asks for purpose, count, provider, and workspace", () => {
  const auth = {
    claude: { provider: "claude" as const, displayName: "Claude Code", status: "authenticated" as const, loginCommand: "", checkedAt: null, error: null },
    codex: { provider: "codex" as const, displayName: "Codex", status: "unauthenticated" as const, loginCommand: "", checkedAt: null, error: null },
  };
  const html = renderToStaticMarkup(<DepartmentCreator initialProvider="claude" initialWorkspacePath="/repo" recentPaths={[]} providers={auth} maxMembers={8} onBrowse={async () => ({ canceled: true })} onCreated={() => {}} onClose={() => {}} />);
  assert.match(html, /直接建立一個部門/);
  assert.match(html, /這是什麼部門/);
  assert.match(html, /NPC 數量/);
  assert.match(html, /部門 AI Provider/);
  assert.match(html, /全部使用此 Provider 的預設模型/);
  assert.match(html, /AI 規劃部門/);
  assert.match(html, /Codex（未登入）/);
});
