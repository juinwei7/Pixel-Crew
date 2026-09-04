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

test("danger tone marks the confirm button and custom labels override defaults", () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog message="刪除後無法復原" confirmLabel="刪除" cancelLabel="保留" tone="danger" onConfirm={() => {}} onCancel={() => {}} />
  );
  assert.match(html, /刪除後無法復原/);
  assert.match(html, /刪除/);
  assert.match(html, /保留/);
  assert.match(html, /confirm-dialog__btn--danger/);
});
