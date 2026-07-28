import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("side panels remain overlays while map controls avoid the visible task panel", () => {
  assert.doesNotMatch(css, /--log-viewport-offset/);
  assert.doesNotMatch(css, /--crew-viewport-offset/);
  assert.doesNotMatch(css, /\.game-root--log-open[^{]*\.game-host/);
  assert.doesNotMatch(css, /\.game-root:not\(\.game-root--focus\) \.game-host/);
  assert.doesNotMatch(app, /game-root--log-open/);
  assert.doesNotMatch(app, /crewViewportOffset/);
  assert.match(css, /\.canvas-zoom\s*\{[\s\S]*?bottom:\s*16px[\s\S]*?left:\s*16px/);
  assert.match(app, /game-root--task-log-open/);
  assert.match(app, /game-root--crew-collapsed/);
  assert.match(css, /\.game-root:not\(\.game-root--task-log-open\) \.crew-rail\s*\{\s*bottom:\s*138px/);
  assert.match(css, /@media \(max-width:\s*599px\)[\s\S]*?\.canvas-zoom input\[type="range"\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.game-root--focus \.canvas-zoom\s*\{[\s\S]*?display:\s*none/);
});

test("task log still owns an independently resizable panel width", () => {
  assert.match(css, /\.holo-panel[\s\S]*?width:\s*min\(var\(--log-panel-width\)/);
  assert.match(app, /"--log-panel-width": `\$\{preferences\.taskLogWidth\}px`/);
});
