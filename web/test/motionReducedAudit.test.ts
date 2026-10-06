import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 減少動態效果一致化：輸入框／對話記錄負責的這幾支 CSS 裡，每一組 @keyframes 都必須在
// prefers-reduced-motion 下被改寫（淡入／淡出／空 keyframes），或屬於下面這張「本來就只動
// 透明度／顏色、或是功能性進度」的白名單。新加動畫忘了處理，這支測試會指名道姓地失敗。
const FILES = [
  "motion.css",
  "motion-fx.css",
  "motion-polish.css",
  "motion-ui.css",
  "motion-ux.css",
  "composer-and-operations.css",
  "r2-composer.css",
];

const ALLOWED_UNCHANGED = new Set([
  "pc-fade-in", "pc-fade-out",          // 本身就是 reduced-motion 的替代動畫
  "pc-prefill-a", "pc-prefill-b",       // 只有邊框顏色
  "pc-ring-flash",                      // 只有透明度、一次性
  "file-drop-overlay-in", "tooltip-fade", "shortcuts-fade", "boss-setup-fade", // 只有透明度
  "pc-receipt-timer",                   // 停留倒數線：元素層級已 animation: none
  "pc-longpress-fill",                  // 長按確認的進度：功能性，改線性但保留
]);

function readStyle(name: string): string {
  return readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");
}

function blockAt(css: string, start: number): string {
  let index = css.indexOf("{", start) + 1;
  let depth = 1;
  while (depth > 0 && index < css.length) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") depth -= 1;
    index += 1;
  }
  return css.slice(start, index);
}

function reducedBlocks(css: string): string[] {
  const blocks: string[] = [];
  const pattern = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css))) blocks.push(blockAt(css, match.index));
  return blocks;
}

test("every keyframe in the composer/log motion files is neutralised under prefers-reduced-motion", () => {
  const defined = new Map<string, string>();
  let reduced = "";
  for (const file of FILES) {
    const css = readStyle(file);
    const blocks = reducedBlocks(css);
    reduced += blocks.join("\n");
    let outside = css;
    for (const block of blocks) outside = outside.replace(block, "");
    for (const match of outside.matchAll(/@keyframes\s+([\w-]+)/g)) defined.set(match[1], file);
  }
  const missing = [...defined]
    .filter(([name]) => !ALLOWED_UNCHANGED.has(name))
    .filter(([name]) => !new RegExp(`@keyframes\\s+${name}(?![\\w-])`).test(reduced))
    .map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, []);
});

test("reduced-motion overrides in r2-composer.css never animate position, scale or rotation", () => {
  const blocks = reducedBlocks(readStyle("r2-composer.css")).join("\n");
  for (const match of blocks.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const body = blockAt(blocks, match.index ?? 0);
    assert.doesNotMatch(body, /translate|scale|rotate|transform/, match[1]);
  }
});
