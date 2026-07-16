import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonaEditor } from "../src/components/PersonaEditor";
import { emptyWorker } from "../src/workerState";

test("renders the persona editor with prefilled fields, template access, and save-as-template", () => {
  const worker = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo", null, { role: "前端 QA", instructions: "測 UI" });
  const html = renderToStaticMarkup(<PersonaEditor worker={worker} onSave={async () => null} onClose={() => {}} />);
  assert.match(html, /NPC PERSONA/);
  assert.match(html, /小助手 的個性與職務/);
  assert.match(html, /前端 QA/);
  assert.match(html, /套用範本/);
  assert.match(html, /存為範本/);
  assert.match(html, /清除人設/); // clear button shows because the worker already has a persona
});

test("hides the clear button when the worker has no persona yet", () => {
  const worker = emptyWorker("w2", "六號機", null, false, 1, "codex", "/repo");
  const html = renderToStaticMarkup(<PersonaEditor worker={worker} onSave={async () => null} onClose={() => {}} />);
  assert.doesNotMatch(html, /清除人設/);
  assert.match(html, /存為範本/);
});
