import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutsHelp } from "../src/components/ShortcutsHelp";

test("labels Professional mode and documents Escape returning to Pixel mode", () => {
  const html = renderToStaticMarkup(<ShortcutsHelp onClose={() => {}} />);
  assert.match(html, /專業模式/);
  assert.match(html, /回到像素模式/);
});
