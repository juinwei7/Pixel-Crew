import assert from "node:assert/strict";
import test from "node:test";
import { insertVoiceTranscript } from "../src/composerCore";

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
