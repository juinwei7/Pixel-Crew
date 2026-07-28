import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSwitchCard } from "../src/components/ModelSwitchCard";

const baseProps = {
  workerName: "架構師",
  currentModelLabel: "Sonnet",
  targetModelLabel: "Opus",
  onContinue: () => {},
  onFresh: () => {},
  onCancel: () => {},
};

test("model switch is an inline chat decision with both session choices", () => {
  const html = renderToStaticMarkup(<ModelSwitchCard {...baseProps} />);
  assert.match(html, /模型切換選擇/);
  assert.match(html, /沿用目前工作階段/);
  assert.match(html, /不交接，開新工作階段/);
  assert.match(html, /NPC 設定與這裡的歷史紀錄都會保留/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("model switch card exposes its focus-mode presentation", () => {
  const html = renderToStaticMarkup(<ModelSwitchCard {...baseProps} focusMode />);
  assert.match(html, /model-switch-card--focus/);
});
