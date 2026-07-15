import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowDocumentEditor } from "../src/components/WorkflowDocumentEditor";

test("renders provider-specific structured workflow fields", () => {
  const claude = renderToStaticMarkup(
    <WorkflowDocumentEditor
      provider="claude"
      content="---\ndescription: Review\nargument-hint: '[branch]'\n---\n\nDo it"
      onChange={() => undefined}
    />,
  );
  assert.match(claude, /用途說明/);
  assert.match(claude, /參數提示/);
  assert.match(claude, /允許工具/);
  assert.match(claude, /RAW/);

  const codex = renderToStaticMarkup(
    <WorkflowDocumentEditor
      provider="codex"
      content="---\nname: review\ndescription: Review\n---\n\nDo it"
      onChange={() => undefined}
    />,
  );
  assert.match(codex, /觸發情境/);
  assert.doesNotMatch(codex, /允許工具/);
});
