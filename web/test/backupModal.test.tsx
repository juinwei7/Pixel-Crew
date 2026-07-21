import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupModal } from "../src/components/BackupModal";

test("renders the export download link and the import file picker by default", () => {
  const html = renderToStaticMarkup(<BackupModal notify={() => {}} onClose={() => {}} />);
  assert.match(html, /備份與還原/);
  assert.match(html, /下載備份（\.tar\.gz）/);
  assert.match(html, /href="[^"]*\/api\/backup\/export"/);
  assert.match(html, /type="file"/);
  // No validated summary/confirm gate yet — nothing has been uploaded.
  assert.doesNotMatch(html, /輸入 RESTORE 以確認/);
  assert.doesNotMatch(html, /確認還原/);
});

test("closing affordance and dialog semantics are present", () => {
  const html = renderToStaticMarkup(<BackupModal notify={() => {}} onClose={() => {}} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /關閉備份與還原/);
});
