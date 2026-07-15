import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenter } from "../src/components/CommandCenter";

test("renders distinct Claude and Codex command experiences", () => {
  const claude = renderToStaticMarkup(
    <CommandCenter workspacePath="/repo" provider="claude" onClose={() => undefined} />,
  );
  assert.match(claude, /Claude 指令中心/);
  assert.match(claude, /.claude\/commands/);

  const codex = renderToStaticMarkup(
    <CommandCenter workspacePath="/repo" provider="codex" onClose={() => undefined} />,
  );
  assert.match(codex, /Codex Skills/);
  assert.match(codex, /.agents\/skills/);
  assert.match(codex, /建立可重複使用的 Codex Skill/);
  assert.doesNotMatch(codex, /建立第一個指令/);
});
