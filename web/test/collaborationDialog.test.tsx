import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollaborationDialog } from "../src/components/CollaborationDialog";
import { emptyWorker } from "../src/workerState";
import type { CollaborationTask } from "../src/types";

const noopAction = async () => null;

test("renders eligible same-workspace NPCs and a structured completed result", () => {
  const source = emptyWorker("source", "建造者", null, false, 0, "claude", "/repo");
  const target = emptyWorker("target", "審查員", null, false, 1, "codex", "/repo");
  const otherRoom = emptyWorker("other", "別房間", null, false, 2, "claude", "/other");
  const task: CollaborationTask = {
    id: "task-1", sourceWorkerId: source.id, targetWorkerId: target.id, workspacePath: "/repo",
    mode: "review", objective: "Review collaboration safety", acceptanceCriteria: ["cite evidence"], status: "completed",
    result: {
      verdict: "changes_requested", summary: "One blocking issue", structured: true,
      findings: [{ severity: "blocking", title: "Missing guard", detail: "Bind the target session", file: "server/src/index.ts", line: 10 }],
      risks: [], openQuestions: [], recommendedNextAction: "Add the guard",
    },
    continuationResult: "Source completed the fixes and reran tests.",
    error: null, createdAt: "2026-07-22T00:00:00.000Z", startedAt: "2026-07-22T00:00:00.000Z",
    completedAt: "2026-07-22T00:01:00.000Z", adoptedAt: "2026-07-22T00:00:30.000Z", handledAt: null,
  };
  const html = renderToStaticMarkup(<CollaborationDialog
    source={source} workers={[source, target, otherRoom]} tasks={[task]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onAdopt={noopAction} onHandled={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /NPC COLLABORATION · READ ONLY/);
  assert.match(html, /審查員 · Codex/);
  assert.doesNotMatch(html, /別房間/);
  assert.match(html, /changes_requested/);
  assert.match(html, /blocking · Missing guard/);
  assert.match(html, /server\/src\/index.ts:10/);
  assert.match(html, /Source completed the fixes and reran tests/);
  assert.match(html, /已自動交回來源 NPC/);
  assert.doesNotMatch(html, />交回 建造者</);
});

test("explains how to add an eligible target when every NPC is in another workspace", () => {
  const source = emptyWorker("source", "建造者", null, false, 0, "claude", "/repo");
  const otherRoom = emptyWorker("other", "別房間", null, false, 1, "codex", "/other");
  const html = renderToStaticMarkup(<CollaborationDialog
    source={source} workers={[source, otherRoom]} tasks={[]}
    onPrepare={async () => ({ error: "unused" })} onStart={noopAction}
    onCancel={noopAction} onAdopt={noopAction} onHandled={noopAction} onClose={() => undefined}
  />);
  assert.match(html, /目前沒有可協作的 NPC/);
  assert.match(html, /左下角「＋」新增 NPC/);
  assert.match(html, /\/repo/);
  assert.match(html, /搬移會重設該 NPC 的對話 session/);
});
