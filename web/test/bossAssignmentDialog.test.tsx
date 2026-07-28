import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BossAssignmentDialog, BossClarificationConversation } from "../src/components/BossAssignmentDialog";

test("renders one Boss entry point with automatic routing and optional model override", () => {
  const html = renderToStaticMarkup(<BossAssignmentDialog
    preferredWorkspace="/repo"
    decisionModels={[{ provider: "claude", model: "sonnet", label: "Claude · Sonnet" }]}
    onAssign={async () => ({ error: "unused" })}
    onRouted={() => {}}
    onClose={() => {}}
  />);
  assert.match(html, /BOSS DESK · SINGLE ENTRY/);
  assert.match(html, /交辦一件工作/);
  assert.match(html, /交辦目標/);
  assert.match(html, /決策模型/);
  assert.match(html, /Claude · Sonnet/);
  assert.match(html, /自動選擇/);
  assert.match(html, /進階設定/);
  assert.match(html, /驗收條件/);
  assert.match(html, /選填/);
  assert.match(html, /交辦給部門/);
  assert.match(html, /依部門職責與 NPC 職務自動分工/);
  assert.doesNotMatch(html, /boss-assignment__flow/);
});

test("renders Boss Assignment inline without modal semantics", () => {
  const html = renderToStaticMarkup(<BossAssignmentDialog
    embedded
    preferredWorkspace="/repo"
    decisionModels={[{ provider: "codex", model: "gpt-5.6", label: "Codex · GPT-5.6" }]}
    onAssign={async () => ({ error: "unused" })}
    onRouted={() => {}}
    onClose={() => {}}
  />);
  assert.match(html, /^<section class="boss-assignment boss-assignment--embedded"/);
  assert.match(html, /交辦一件工作/);
  assert.match(html, /mission-dialog__card--embedded/);
  assert.match(html, /collaboration-dialog__form/);
  assert.match(html, /collaboration-dialog__actions/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.doesNotMatch(html, /aria-modal/);
});

test("renders clarification as an inline reply conversation instead of an error", () => {
  const html = renderToStaticMarkup(<BossClarificationConversation
    turns={[{
      question: "這裡的「每位同事」是指金融部門成員，還是整間公司的所有同事？",
      answer: "是整間公司的所有同事。",
    }]}
    question="需要包含目前離線的同事嗎？"
    reply=""
    working={false}
    onReplyChange={() => {}}
    onSubmit={() => {}}
  />);
  assert.match(html, /決策模型需要你補充/);
  assert.match(html, /原始交辦目標與驗收條件會保持不變/);
  assert.match(html, /是整間公司的所有同事/);
  assert.match(html, /需要包含目前離線的同事嗎/);
  assert.match(html, /回覆決策模型/);
  assert.match(html, /送出回覆/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /role="dialog"/);
});
