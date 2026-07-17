import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GameCanvas } from "../src/components/GameCanvas";
import { emptyWorker } from "../src/workerState";
import type { ApprovalDecision, Turn } from "../src/types";

function pendingApprovalTurn(decisions: ApprovalDecision[]): Turn {
  return {
    key: "turn-live",
    command: "安裝依賴",
    status: "running",
    items: [{
      kind: "approval",
      key: "approval",
      status: "pending",
      request: {
        id: "approval-1",
        activityId: "cmd",
        category: "command",
        title: "允許執行 npm install？",
        input: { command: "npm install" },
        command: "npm install",
        cwd: "/repo",
        decisions,
      },
    }],
  };
}

test("shows the NPC's persona role as a persistent badge on the nameplate", () => {
  const withRole = emptyWorker("w1", "小助手", null, false, 0, "claude", "/repo", null, { role: "前端 QA", instructions: "" });
  const html = renderToStaticMarkup(
    <GameCanvas workers={[withRole]} activeId="w1" onSelect={() => {}} />,
  );
  assert.match(html, /npc-nameplate__role/);
  assert.match(html, /前端 QA/);
});

test("omits the role badge entirely when the NPC has no persona", () => {
  const noRole = emptyWorker("w1", "六號機", null, false, 0, "codex", "/repo");
  const html = renderToStaticMarkup(
    <GameCanvas workers={[noRole]} activeId="w1" onSelect={() => {}} />,
  );
  assert.doesNotMatch(html, /npc-nameplate__role/);
});

test("shows a floating approve/deny bar on the sprite for a pending approval, right on the canvas", () => {
  const worker = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [pendingApprovalTurn(["allow_once", "allow_session", "deny"])] };
  const html = renderToStaticMarkup(
    <GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} onResolveApproval={async () => null} />,
  );
  assert.match(html, /npc-approval-bar/);
  assert.match(html, /允許執行 npm install？/);
  assert.match(html, /拒絕/);
  assert.match(html, /本次皆允許/);
});

test("omits the allow-for-session button when the request doesn't offer it", () => {
  const worker = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [pendingApprovalTurn(["allow_once", "deny"])] };
  const html = renderToStaticMarkup(
    <GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} onResolveApproval={async () => null} />,
  );
  assert.match(html, /npc-approval-bar/);
  assert.doesNotMatch(html, /本次皆允許/);
});

test("never shows the approval bar when onResolveApproval isn't wired up", () => {
  const worker = { ...emptyWorker("w1", "小助手", null, true, 0, "claude", "/repo"), turns: [pendingApprovalTurn(["allow_once", "deny"])] };
  const html = renderToStaticMarkup(<GameCanvas workers={[worker]} activeId="w1" onSelect={() => {}} />);
  assert.doesNotMatch(html, /npc-approval-bar/);
});
