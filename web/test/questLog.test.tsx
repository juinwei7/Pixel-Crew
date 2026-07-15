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
