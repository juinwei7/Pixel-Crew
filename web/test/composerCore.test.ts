import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { composerTextareaHeight, explicitComposerLineCount, insertVoiceTranscript, MAX_COMPOSER_LINES } from "../src/composerCore";

test("explicitComposerLineCount grows with newlines up to the 10-line cap", () => {
  assert.equal(MAX_COMPOSER_LINES, 10);
  assert.equal(explicitComposerLineCount(""), 1);
  assert.equal(explicitComposerLineCount("一行"), 1);
  assert.equal(explicitComposerLineCount("一\n二\n三"), 3);
  assert.equal(explicitComposerLineCount(Array.from({ length: 20 }, (_, i) => `第${i}行`).join("\n")), 10);
});

test("composerTextareaHeight honors custom line-height/padding so each composer variant matches its own CSS", () => {
  assert.equal(composerTextareaHeight("單行", 18.85, 6), 1 * 18.85 + 6);
  assert.equal(composerTextareaHeight("一\n二\n三", 22, 16), 3 * 22 + 16);
  assert.equal(composerTextareaHeight(Array.from({ length: 20 }, (_, i) => `第${i}行`).join("\n"), 22, 16), 10 * 22 + 16);
});

test("insertVoiceTranscript replaces an empty or whitespace-only draft", () => {
  assert.equal(insertVoiceTranscript("", "你好"), "你好");
  assert.equal(insertVoiceTranscript("   ", "你好"), "你好");
});

test("insertVoiceTranscript appends to existing text with a separating space", () => {
  assert.equal(insertVoiceTranscript("幫我看一下", "這個檔案"), "幫我看一下 這個檔案");
});

test("insertVoiceTranscript does not double up whitespace already at the end", () => {
  assert.equal(insertVoiceTranscript("幫我看一下 ", "這個檔案"), "幫我看一下 這個檔案");
  assert.equal(insertVoiceTranscript("幫我看一下\n", "這個檔案"), "幫我看一下\n這個檔案");
});

test("the composer toolbar's icon buttons are centred and its menu opens inwards", () => {
  // 指令列那排鈕在手機貼在一起，任何一顆沒置中都看得出來；圓桌 ⋯ 是最後一顆，
  // 選單往右長就會衝出視窗（390px 下超出 1px、320px 下超出 71px）。
  const css = readFileSync(new URL("../src/styles/composer-and-operations.css", import.meta.url), "utf8");
  const mic = css.slice(css.indexOf(".voice-input__mic {"));
  assert.match(mic.slice(0, mic.indexOf("}")), /justify-content: center;/);
  const menu = css.slice(css.indexOf(".composer-roundtable-menu {"));
  const block = menu.slice(0, menu.indexOf("}"));
  assert.match(block, /right: 0;/);
  assert.doesNotMatch(block, /left: 0;/);
  assert.match(block, /max-width: calc\(100vw/);
});
