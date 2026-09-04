import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

test("renders the message and default confirm/cancel labels", () => {
  const html = renderToStaticMarkup(<ConfirmDialog message="確定要繼續嗎？" onConfirm={() => {}} onCancel={() => {}} />);
  assert.match(html, /確定要繼續嗎？/);
  assert.match(html, /確定/);
  assert.match(html, /取消/);
  assert.doesNotMatch(html, /confirm-dialog__btn--danger/);
});

test("danger tone marks the confirm button", () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog message="刪除後無法復原" tone="danger" onConfirm={() => {}} onCancel={() => {}} />
  );
  assert.match(html, /刪除後無法復原/);
  assert.match(html, /confirm-dialog__btn--danger/);
});
