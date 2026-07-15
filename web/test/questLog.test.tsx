import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestLog } from "../src/components/QuestLog";
import type { Turn } from "../src/types";

test("groups consecutive tools and highlights the completed final response", () => {
  const turn: Turn = {
    key: "turn-1",
    command: "檢查專案",
    status: "done",
    durationMs: 100,
    costUsd: 0,
    items: [
      { kind: "tool_call", key: "tool-1", id: "1", name: "Read", input: {}, output: "ok", isError: false, status: "done" },
      { kind: "tool_call", key: "tool-2", id: "2", name: "Bash", input: {}, output: "ok", isError: false, status: "done" },
      { kind: "assistant_text", key: "text-1", text: "完整結果" },
    ],
  };

  const html = renderToStaticMarkup(<QuestLog turns={[turn]} />);
  assert.match(html, /工具活動/);
  assert.match(html, /2 項/);
  assert.match(html, /FINAL RESPONSE/);
  assert.match(html, /完整結果/);
});

test("shows live output and approval actions while a turn is running", () => {
  const turn: Turn = {
    key: "turn-live",
    command: "安裝依賴",
    status: "running",
    items: [
      { kind: "tool_call", key: "tool", id: "cmd", name: "Bash", input: { command: "npm install" }, output: "resolving…", isError: false, status: "running" },
      {
        kind: "approval",
        key: "approval",
        status: "pending",
        request: {
          id: "approval-1",
          activityId: "cmd",
          category: "command",
          title: "允許執行？",
          input: { command: "npm install" },
          command: "npm install",
          cwd: "/repo",
          decisions: ["allow_once", "allow_session", "deny"],
        },
      },
    ],
  };
  const html = renderToStaticMarkup(<QuestLog turns={[turn]} onApprove={async () => null} />);
  assert.match(html, /OUTPUT/);
  assert.match(html, /LIVE/);
  assert.match(html, /等待核准/);
  assert.match(html, /允許這一次/);
  assert.match(html, /本次皆允許/);
  assert.match(html, /npm install/);
});

test("summary mode keeps the final response and hides intermediate assistant narration", () => {
  const turn: Turn = {
    key: "summary",
    command: "review",
    status: "done",
    items: [
      { kind: "assistant_text", key: "middle", text: "中間說明不應預設顯示" },
      { kind: "tool_call", key: "tool", id: "tool", name: "Read", input: {}, output: "ok", isError: false, status: "done" },
      { kind: "assistant_text", key: "final", text: "這是最後答案" },
    ],
  };
  const summary = renderToStaticMarkup(<QuestLog turns={[turn]} view="summary" />);
  const activity = renderToStaticMarkup(<QuestLog turns={[turn]} view="activity" />);
  assert.doesNotMatch(summary, /中間說明不應預設顯示/);
  assert.match(summary, /這是最後答案/);
  assert.match(activity, /中間說明不應預設顯示/);
});
