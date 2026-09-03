import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalMemoryModal } from "../src/components/GlobalMemoryModal";

test("renders in a loading state before the initial fetch resolves (SSR never runs useEffect)", () => {
  const html = renderToStaticMarkup(<GlobalMemoryModal globalMemoryEvent={null} onClose={() => {}} />);
  assert.match(html, /全域記憶/);
  assert.match(html, /跨所有 NPC 共用的長期記憶/);
  assert.match(html, /讀取中…/);
});

test("shows the add button disabled when there is no draft note yet", () => {
  const html = renderToStaticMarkup(<GlobalMemoryModal globalMemoryEvent={null} onClose={() => {}} />);
  assert.match(html, /＋記住/);
  assert.match(html, /disabled=""/);
});
