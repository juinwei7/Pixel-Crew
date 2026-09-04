import assert from "node:assert/strict";
import test from "node:test";
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
