import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutsHelp } from "../src/components/ShortcutsHelp";

test("labels Professional mode and scopes Escape to leaving Professional mode", () => {
  const html = renderToStaticMarkup(<ShortcutsHelp onClose={() => {}} />);
  assert.match(html, /專業模式/);
  assert.match(html, /離開專業模式/);
  assert.doesNotMatch(html, /回到像素模式/);
});
