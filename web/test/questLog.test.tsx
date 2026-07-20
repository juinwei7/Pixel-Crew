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

test("focus mode reads every final response without tool or thinking noise", () => {
  const turns: Turn[] = [
    {
      key: "older",
      command: "舊任務",
      status: "done",
      items: [{ kind: "assistant_text", key: "old-final", text: "舊報告內容" }],
    },
    {
      key: "latest",
      command: "撰寫最新報告",
      status: "done",
      durationMs: 1234,
      items: [
        { kind: "thinking", key: "thinking", text: "內部思考內容" },
        { kind: "assistant_text", key: "progress", text: "中間進度內容" },
        { kind: "tool_call", key: "tool", id: "tool", name: "Read", input: {}, output: "工具輸出內容", isError: false, status: "done" },
        { kind: "assistant_text", key: "final", text: "最新完整報告" },
      ],
    },
  ];

  const html = renderToStaticMarkup(<QuestLog turns={turns} view="activity" focusMode />);
  assert.match(html, /舊任務/);
  assert.match(html, /舊報告內容/);
  assert.match(html, /報告章節導覽/);
  assert.match(html, /報告導覽/);
  assert.match(html, /focus-turn-/);
  assert.match(html, /撰寫最新報告/);
  assert.match(html, /最新完整報告/);
  assert.match(html, /FINAL RESPONSE/);
  assert.doesNotMatch(html, /內部思考內容/);
  assert.doesNotMatch(html, /中間進度內容/);
  assert.doesNotMatch(html, /工具輸出內容/);
  assert.doesNotMatch(html, /1\.2s/);
});

test("focus mode keeps pending approvals visible even when they belong to an older turn", () => {
  const turns: Turn[] = [
    {
      key: "approval-turn",
      command: "需要權限",
      status: "running",
      items: [{
        kind: "approval",
        key: "approval",
        status: "pending",
        request: {
          id: "approval-1",
          activityId: null,
          category: "command",
          title: "請核准部署",
          input: { command: "deploy" },
          command: "deploy",
          decisions: ["allow_once", "deny"],
        },
      }],
    },
    {
      key: "latest",
      command: "最新任務",
      status: "done",
      items: [{ kind: "assistant_text", key: "final", text: "最新報告" }],
    },
  ];

  const html = renderToStaticMarkup(<QuestLog turns={turns} focusMode onApprove={async () => null} />);
  assert.match(html, /需要你的核准/);
  assert.match(html, /請核准部署/);
  assert.match(html, /最新報告/);
});

test("focus mode keeps the latest readable report and acknowledges a newly sent turn", () => {
  const turns: Turn[] = [
    {
      key: "report",
      command: "完成報告",
      status: "done",
      items: [{ kind: "assistant_text", key: "report-text", text: "可以繼續閱讀的報告" }],
    },
    {
      key: "starting",
      command: "剛開始的新任務",
      status: "running",
      items: [{ kind: "tool_call", key: "tool", id: "tool", name: "Read", input: {}, isError: false, status: "running" }],
    },
  ];

  const html = renderToStaticMarkup(<QuestLog turns={turns} focusMode />);
  assert.match(html, /可以繼續閱讀的報告/);
  assert.match(html, /剛開始的新任務/);
  assert.match(html, /指令已送出/);
  assert.match(html, /NPC 正在處理中/);
  assert.match(html, /role="status"/);
});

test("focus navigation includes report headings and search exposes result controls", () => {
  const turns: Turn[] = [{
    key: "report",
    command: "整理付款報告",
    status: "done",
    items: [{ kind: "assistant_text", key: "final", text: "# 結論\n\n付款流程需要修復。\n\n## 風險\n\n付款可能失敗。" }],
  }];
  const html = renderToStaticMarkup(<QuestLog turns={turns} focusMode searchQuery="付款" />);
  assert.match(html, /focus-report-nav__heading--1/);
  assert.match(html, /focus-report-nav__heading--2/);
  assert.match(html, /結論/);
  assert.match(html, /風險/);
  assert.match(html, /<strong>3<\/strong> 處 · 1 筆任務/);
  assert.match(html, /上一筆搜尋結果/);
  assert.match(html, /下一筆搜尋結果/);
  assert.match(html, /search-highlight/);
  assert.match(html, /複製整份/);
  assert.match(html, /匯出 \.md/);
  assert.match(html, /釘選這份報告/);
});

test("focus mode keeps the last readable response from a failed turn", () => {
  const turn: Turn = {
    key: "failed-report",
    command: "產生報告",
    status: "error",
    items: [{ kind: "assistant_text", key: "partial", text: "失敗前已整理的可讀內容" }],
  };
  const html = renderToStaticMarkup(<QuestLog turns={[turn]} focusMode />);
  assert.match(html, /失敗前已整理的可讀內容/);
  assert.match(html, /turn-chip--error/);
});
