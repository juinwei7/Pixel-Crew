import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUNDTABLE_READ_LIMIT,
  isRoundtableCommand,
  roundtableChallengePrompt,
  roundtableCommandKind,
  roundtableEscalationTopic,
  roundtableExecutePrompt,
  roundtablePrompt,
  roundtableTopicFromCommand,
} from "../src/roundtablePrompt.js";

test("roundtable prompt embeds the topic and pins the one-shot / no-dispatch / result-first contract", () => {
  const prompt = roundtablePrompt("  要不要導入 CI  ");
  assert.match(prompt, /要不要導入 CI/);
  assert.doesNotMatch(prompt, /  要不要導入 CI  /); // 有 trim
  assert.match(prompt, /不要呼叫任何工具/);
  assert.match(prompt, /一次性/);
  assert.match(prompt, /不要派工/);
  assert.match(prompt, /## 結論/);
  assert.match(prompt, /## 圓桌意見/);
});

test("first line is a readable headline so log cards / nav / search can tell roundtables apart", () => {
  const prompt = roundtablePrompt("要不要導入 CI\n補充：目前只有手動測試");
  assert.equal(prompt.split("\n")[0], "【快速圓桌】要不要導入 CI");
  const long = roundtablePrompt("長".repeat(200));
  const headline = long.split("\n")[0];
  assert.ok(Array.from(headline).length <= "【快速圓桌】".length + 81, "headline is clipped");
  assert.ok(headline.endsWith("…"));
  // 完整主題仍在本文裡
  assert.match(long, new RegExp(`討論主題：${"長".repeat(200)}`));
});

test("roles must be specific, conflicting, and include a dissenter with their own trade-off criterion", () => {
  const prompt = roundtablePrompt("要不要換資料庫");
  assert.match(prompt, /真的會意見相左/);
  assert.match(prompt, /反方/);
  assert.match(prompt, /取捨標準/);
});

test("conclusion section demands a decision, confidence, and what would change it", () => {
  const prompt = roundtablePrompt("要不要換資料庫");
  assert.match(prompt, /## 信心/);
  assert.match(prompt, /高／中／低/);
  assert.match(prompt, /## 什麼情況會改變結論/);
  assert.match(prompt, /## 下一步/);
  assert.match(prompt, /升級作戰室/);
  // 段落順序：意見 → 結論 → 信心 → 改變條件 → 下一步
  const order = ["## 圓桌意見", "## 結論", "## 信心", "## 什麼情況會改變結論", "## 下一步"].map((heading) => prompt.indexOf(heading));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index >= 0));
});

test("project context: bounded read-only lookups with an explicit cap and no writes", () => {
  const prompt = roundtablePrompt("要不要換資料庫");
  assert.equal(ROUNDTABLE_READ_LIMIT, 3);
  assert.match(prompt, new RegExp(`最多 ${ROUNDTABLE_READ_LIMIT} 次唯讀查閱`));
  assert.match(prompt, /不得寫檔/);
  assert.match(prompt, /不碰 Git 寫入/);
  assert.match(prompt, /寫明你的假設/);
});

test("command kind detection recognises every roundtable variant and ignores normal commands", () => {
  assert.equal(roundtableCommandKind(roundtablePrompt("x")), "roundtable");
  assert.equal(roundtableCommandKind(roundtableChallengePrompt("x", "做")), "challenge");
  assert.equal(roundtableCommandKind(roundtableExecutePrompt("x", { conclusion: "做", nextSteps: [], changeTriggers: [] })), "execute");
  assert.equal(roundtableCommandKind("[Quick Roundtable]Should we ship?"), "roundtable");
  assert.equal(roundtableCommandKind("幫我修 bug"), null);
  assert.equal(isRoundtableCommand(roundtablePrompt("x")), true);
  assert.equal(isRoundtableCommand(roundtableChallengePrompt("x", "做")), true);
  // 照結論執行是一般工作回合，不再跳出圓桌結論小卡
  assert.equal(isRoundtableCommand(roundtableExecutePrompt("x", { conclusion: "做", nextSteps: [], changeTriggers: [] })), false);
});

test("full topic (multi-line, longer than the headline) is recovered from the command", () => {
  const topic = `要不要導入 CI\n\n補充：目前只有手動測試，${"細節".repeat(60)}`;
  assert.equal(roundtableTopicFromCommand(roundtablePrompt(topic)), topic);
  assert.equal(roundtableTopicFromCommand(roundtableChallengePrompt(topic, "導入")), topic);
  assert.equal(roundtableTopicFromCommand(roundtableChallengePrompt(topic, "")), topic);
  assert.equal(roundtableTopicFromCommand("【快速圓桌】只有標題列"), "只有標題列");
});

test("counter-check prompt stays one-shot, carries the conclusion, and asks keep-or-revise", () => {
  const prompt = roundtableChallengePrompt("要不要導入 CI", "導入 GitHub Actions");
  assert.match(prompt, /^【快速圓桌・反方檢驗】要不要導入 CI/);
  assert.match(prompt, /待檢驗的結論：導入 GitHub Actions/);
  assert.match(prompt, /最強反對論點/);
  assert.match(prompt, /「維持」或「修正」/);
  assert.match(prompt, /不要呼叫任何工具/);
  assert.match(prompt, /## 結論/);
});

test("execute prompt hands over conclusion, ordered steps, and stop-and-report triggers", () => {
  const prompt = roundtableExecutePrompt("要不要導入 CI", {
    conclusion: "導入 GitHub Actions",
    nextSteps: ["加 lint", "加測試", "加部署", "多的一步"],
    changeTriggers: ["月費超過預算"],
  });
  assert.match(prompt, /^【快速圓桌・照結論執行】要不要導入 CI/);
  assert.match(prompt, /結論：導入 GitHub Actions/);
  assert.match(prompt, /1\. 加 lint\n2\. 加測試\n3\. 加部署/);
  assert.doesNotMatch(prompt, /多的一步/);
  assert.match(prompt, /先停下來回報/);
  assert.match(prompt, /- 月費超過預算/);
  const bare = roundtableExecutePrompt("x", { conclusion: "", nextSteps: [], changeTriggers: [] });
  assert.doesNotMatch(bare, /依序處理|先停下來回報|結論：/);
});

test("escalation topic keeps the original topic first and attaches a clipped initial call", () => {
  assert.equal(roundtableEscalationTopic("  要不要導入 CI ", { conclusion: "", confidence: null }), "要不要導入 CI");
  const topic = roundtableEscalationTopic("要不要導入 CI", { conclusion: "導入", confidence: "低" });
  assert.ok(topic.startsWith("要不要導入 CI\n\n"));
  assert.match(topic, /快速圓桌初判：導入（信心：低）/);
  const long = roundtableEscalationTopic("t", { conclusion: "長".repeat(1000), confidence: null });
  assert.ok(long.length < 500);
});
