import assert from "node:assert/strict";
import test from "node:test";
import { roundtablePrompt } from "../src/roundtablePrompt.js";

test("roundtable prompt embeds the topic and pins the one-shot / no-tools / result-first contract", () => {
  const prompt = roundtablePrompt("  要不要導入 CI  ");
  assert.match(prompt, /要不要導入 CI/);
  assert.doesNotMatch(prompt, /  要不要導入 CI  /); // 有 trim
  assert.match(prompt, /不要呼叫任何工具/);
  assert.match(prompt, /一次性/);
  assert.match(prompt, /## ✅ 結論/);
  assert.match(prompt, /## 🗣️ 圓桌意見/);
});
