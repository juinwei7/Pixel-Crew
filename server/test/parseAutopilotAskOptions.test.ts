// 「循環問你」選項解析測試：從停止理由抽出可一鍵回答的 A/B/C/D 或 甲乙丙丁 標籤。
import assert from "node:assert/strict";
import test from "node:test";
import { parseAutopilotAskOptions } from "../src/workerAutopilot.js";

test("抽出 A/B/C 字母選項", () => {
  assert.deepEqual(parseAutopilotAskOptions("要縮短嗎？A 維持 150s／B 縮到 60s／C 不改"), ["A", "B", "C"]);
});

test("抽出甲乙丙丁中文標籤", () => {
  assert.deepEqual(parseAutopilotAskOptions("甲、維持；乙、縮短；丙、通知"), ["甲", "乙", "丙"]);
});

test("只有單一字母不算選項題（避免誤抓）", () => {
  assert.deepEqual(parseAutopilotAskOptions("這步 A 做完了，接著收尾"), []);
});

test("去重＋上限 4（每個選項都帶說明）", () => {
  const r = parseAutopilotAskOptions("A 維持／B 縮短／C 通知／D 忽略，預設 A");
  assert.deepEqual(r, ["A", "B", "C", "D"]);
});

test("只是『提到』A/B/C 的複合詞不算選項（無說明）", () => {
  // owner 實測回報：卡片給了按鈕卻沒說明各代表什麼——根因就是這種誤抓。
  assert.deepEqual(parseAutopilotAskOptions("NPC 已把 A/B/C 三個選項清楚列出並交還決定權"), []);
});

test("無選項的純結論回空", () => {
  assert.deepEqual(parseAutopilotAskOptions("已完成並驗證，無待辦"), []);
});

test("非字串安全回空", () => {
  assert.deepEqual(parseAutopilotAskOptions(undefined as unknown as string), []);
});
