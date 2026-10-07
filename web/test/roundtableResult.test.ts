import assert from "node:assert/strict";
import test from "node:test";
import { confidenceLabel, latestRoundtable, parseConfidence, parseRoundtableResult } from "../src/roundtableResult.js";
import { roundtablePrompt } from "../src/roundtablePrompt.js";
import type { Turn } from "../src/types.js";

const REPLY = [
  "## 圓桌意見",
  "- **值班維運（保守）**：先不要；在意：半夜被叫；理由：沒有監控",
  "- **產品（推進）**：要；在意：上市時程；理由：客戶在等",
  "",
  "## 結論",
  "**先導入最小 CI**，只跑 lint 與單元測試。",
  "部署自動化延後。",
  "",
  "## 信心",
  "中 — 缺少實際失敗率資料。",
  "",
  "## 什麼情況會改變結論",
  "- 每月 CI 費用超過預算",
  "- 測試時間超過 10 分鐘",
  "",
  "## 下一步",
  "1. 加 lint workflow",
  "2. 把單元測試接上",
].join("\n");

test("parses conclusion, confidence, change triggers, and next steps from the reply", () => {
  const result = parseRoundtableResult(REPLY);
  assert.equal(result.conclusion, "先導入最小 CI，只跑 lint 與單元測試。 部署自動化延後。");
  assert.equal(result.confidence, "medium");
  assert.match(result.confidenceNote, /缺少實際失敗率/);
  assert.deepEqual(result.changeTriggers, ["每月 CI 費用超過預算", "測試時間超過 10 分鐘"]);
  assert.deepEqual(result.nextSteps, ["加 lint workflow", "把單元測試接上"]);
  assert.equal(result.suggestsWarroom, false);
});

test("missing sections degrade to empty values instead of throwing", () => {
  const result = parseRoundtableResult("只是一段沒有格式的回答");
  assert.equal(result.conclusion, "");
  assert.equal(result.confidence, null);
  assert.deepEqual(result.nextSteps, []);
  assert.deepEqual(parseRoundtableResult("## 下一步\n- 無").nextSteps, []);
});

test("English headings are recognised too (language switch keeps old replies working)", () => {
  const result = parseRoundtableResult("## Conclusion\nShip it.\n\n## Confidence\nHigh — tested.\n\n## Next steps\n- Tag release");
  assert.equal(result.conclusion, "Ship it.");
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.nextSteps, ["Tag release"]);
});

test("later duplicate sections win (final answer after read-only lookups)", () => {
  const result = parseRoundtableResult("## 結論\n草稿\n\n（查了一下檔案）\n\n## 結論\n定稿");
  assert.equal(result.conclusion, "定稿");
});

test("confidence parsing and war room suggestion", () => {
  assert.equal(parseConfidence("**低** — 資料不足"), "low");
  assert.equal(parseConfidence("信心：高"), "high");
  assert.equal(parseConfidence("Moderate, because"), "medium");
  assert.equal(parseConfidence("不確定"), null);
  assert.equal(parseRoundtableResult("## 結論\n做\n## 信心\n低 — 沒資料").suggestsWarroom, true);
  assert.equal(parseRoundtableResult("## 結論\n做\n## 信心\n中 — 代價高，建議升級作戰室").suggestsWarroom, true);
  assert.equal(parseRoundtableResult("## 結論\n做\n## 信心\n高 — 不需要升級作戰室").suggestsWarroom, false);
  assert.equal(confidenceLabel("low"), "低");
  assert.equal(confidenceLabel(null), null);
});

function turn(command: string, text: string, status: Turn["status"] = "done"): Turn {
  return { key: `k-${command.length}-${status}`, command, status, items: [{ kind: "assistant_text", key: "a", text }] };
}

test("latestRoundtable only surfaces a finished roundtable that is the newest turn", () => {
  const rt = turn(roundtablePrompt("要不要導入 CI"), REPLY);
  const latest = latestRoundtable([rt]);
  assert.ok(latest);
  assert.equal(latest.topic, "要不要導入 CI");
  assert.equal(latest.result.confidence, "medium");
  assert.equal(latestRoundtable([{ ...rt, status: "running" }]), null);
  assert.equal(latestRoundtable([rt, turn("幫我修 bug", "好")]), null);
  assert.equal(latestRoundtable([turn(roundtablePrompt("x"), "沒有照格式")]), null);
  assert.equal(latestRoundtable([]), null);
  assert.equal(latestRoundtable(undefined), null);
});
