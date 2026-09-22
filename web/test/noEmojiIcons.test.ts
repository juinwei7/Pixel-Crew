import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 介面圖示一律走 components/Icon.tsx 的線性 icon，不再用 emoji。

   emoji 的字形由作業系統決定：同一顆在 macOS / Windows / Android 長得完全
   不一樣，吃不到 currentColor，也沒辦法跟著粗細與尺寸的 token 調整。 */

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = dir + entry;
    if (statSync(full).isDirectory()) walk(full + "/", out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/* Emoji_Presentation 的常見區段，扣掉排版用的線條符號——那些是文字字形，
   跨平台一致，也是這個等寬終端機風格的一部分。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}\u{FE0F}]/u;
const TEXT_GLYPHS = new Set([..."✓✔✕✖✗✎✏✦✧★☆⌕⌄⌃⌘⇧⧉→←↑↓↔·•≡⟳↻⌫⏎"]);

/* 只有 icon 定義檔本身可以在註解裡舉 emoji 當對照。 */
const ALLOWED = new Set(["src/components/Icon.tsx"]);

test("no emoji is used as a UI icon", () => {
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    const rel = "src/" + file.slice(srcDir.length);
    if (ALLOWED.has(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const char of line) {
        if (!EMOJI.test(char) || TEXT_GLYPHS.has(char)) continue;
        offenders.push(`${rel}:${index + 1} ${char} — ${line.trim().slice(0, 56)}`);
        break;
      }
    });
  }
  assert.deepEqual(offenders, [], `改用 <Icon name="…" />：\n${offenders.join("\n")}`);
});

test("the icon set stays one consistent family", () => {
  const icon = readFileSync(srcDir + "components/Icon.tsx", "utf8");
  // 同一個 24 格、同一種筆畫、一律 currentColor——混入填色或別的粗細就會
  // 立刻看得出來不是同一套。
  assert.match(icon, /viewBox="0 0 24 24"/);
  assert.match(icon, /stroke="currentColor"/);
  assert.match(icon, /strokeWidth=\{1\.8\}/);
  assert.match(icon, /fill="none"/);
  assert.doesNotMatch(icon, /fill="(?!none)/);
});
