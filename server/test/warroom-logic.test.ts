import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerEvent } from "../src/claudeRunner.js";
import {
  parseWarroomPosition,
  parseWarroomResult,
  warroomContextBrief,
  warroomHostConfidenceNote,
  warroomOpeningPrompt,
  warroomOthersDigest,
  warroomRebuttalNeeded,
  warroomRebuttalPrompt,
  warroomReportExtras,
  warroomSynthesisPrompt,
} from "../src/warroom.js";

const turnEnd = (resultText: string): RunnerEvent => ({ type: "turn_end", resultText, costUsd: 0, durationMs: 0, isError: false, permissionDenials: [] });

test("context brief carries host, project and a clipped recent conversation, bounded in size", () => {
  const events: RunnerEvent[] = [
    { type: "user_message", text: "很久以前的訊息" },
    turnEnd("舊回覆"),
    { type: "user_message", text: "幫我把登入流程改成 OAuth" },
    turnEnd("x".repeat(1_000)),
  ];
  const brief = warroomContextBrief({ hostName: "一號機", hostRole: "後端", workspacePath: "C:\work\shop-app", events });
  assert.match(brief, /一號機（後端）/);
  assert.match(brief, /shop-app/);
  assert.match(brief, /OAuth/);
  assert.doesNotMatch(brief, /很久以前/); // 只取最近 3 則
  assert.match(brief, /…/); // 長訊息被截短
  assert.ok(brief.length <= 900);
  const empty = warroomContextBrief({ hostName: "", workspacePath: "/repo/", events: [] });
  assert.match(empty, /repo/);
  assert.doesNotMatch(empty, /最近的對話/);
});

test("context only appears when provided and stays out of the rebuttal round", () => {
  assert.doesNotMatch(warroomOpeningPrompt({ topic: "t", stanceBrief: "b" }), /【背景】/);
  const opening = warroomOpeningPrompt({ topic: "t", stanceBrief: "b", context: "召集人：A；專案：p" });
  assert.match(opening, /【背景】\n召集人：A/);
  assert.match(opening, /<position>GO<\/position>/);
  const rebuttal = warroomRebuttalPrompt({ stanceBrief: "b", othersDebate: "o" });
  assert.match(rebuttal, /第 1 輪的主張/);
  assert.doesNotMatch(rebuttal, /【背景】/);
});

test("position signal parses the last tag, case-insensitively", () => {
  assert.equal(parseWarroomPosition("一堆理由\n<position>GO</position>"), "GO");
  assert.equal(parseWarroomPosition("<position>no</position> 後來改口 <position> HOLD </position>"), "HOLD");
  assert.equal(parseWarroomPosition("沒有標"), null);
  assert.equal(parseWarroomPosition("<position>MAYBE</position>"), null);
});

test("rebuttal round is skipped only on unanimous, fully-signalled openings without a verifier", () => {
  const three = [{ key: "propose" }, { key: "challenge" }, { key: "weigh" }];
  const go = "理由\n<position>GO</position>";
  assert.equal(warroomRebuttalNeeded(three, [go, go, go]), false);
  assert.equal(warroomRebuttalNeeded(three, [go, go, "<position>NO</position>"]), true);
  assert.equal(warroomRebuttalNeeded(three, [go, go, ""]), true); // 有人沒發言成功
  assert.equal(warroomRebuttalNeeded(three, [go, go, "沒標信號"]), true);
  assert.equal(warroomRebuttalNeeded([...three, { key: "verify" }], [go, go, go, go]), true); // 查證席要看別人主張
  assert.equal(warroomRebuttalNeeded([{ key: "propose" }], [go]), true);
});

test("rebuttal digest excludes the speaker's own opening", () => {
  const stances = [{ name: "提案" }, { name: "挑戰" }, { name: "權衡" }];
  const digest = warroomOthersDigest(stances, ["A 的主張", "", "C 的主張"], 0);
  assert.doesNotMatch(digest, /提案|A 的主張/);
  assert.match(digest, /【挑戰】\n\(無\)/);
  assert.match(digest, /【權衡】\nC 的主張/);
});

test("synthesis prompt reflects the real debate shape and asks for confidence / flip conditions / rejected options", () => {
  const medium = warroomSynthesisPrompt({ topic: "x", debate: "d", peerCount: 3, rounds: 2 });
  assert.match(medium, /3 方兩輪/);
  assert.match(medium, /"confidence"/);
  assert.match(medium, /"flip_if"/);
  assert.match(medium, /"rejected"/);
  assert.match(warroomSynthesisPrompt({ topic: "x", debate: "d", peerCount: 2, rounds: 1 }), /2 方的一輪表態/);
  assert.match(warroomSynthesisPrompt({ topic: "x", debate: "d", peerCount: 3, rounds: 2, earlyConsensus: true }), /省略反駁輪/);
  assert.match(warroomSynthesisPrompt({ topic: "x", debate: "d", context: "召集人：A" }), /【背景】/);
});

test("parses confidence, flip conditions and rejected options; tolerates junk and absence", () => {
  const result = parseWarroomResult(`<warroom_result>{"verdict":"先做 A","confidence":"LOW",
    "flip_if":["若壓測 p95 > 300ms","",  "第三條","第四條要被截掉"],
    "rejected":[{"option":"全面重寫","reason":"風險太高"},{"option":"","reason":"沒選項名要丟"},{"option":"維持現狀"}],
    "actions":[]}</warroom_result>`);
  assert.equal(result?.confidence, "low");
  assert.deepEqual(result?.flipIf, ["若壓測 p95 > 300ms", "第三條", "第四條要被截掉"]);
  assert.deepEqual(result?.rejected, [{ option: "全面重寫", reason: "風險太高" }, { option: "維持現狀", reason: "" }]);
  const plain = parseWarroomResult(`<warroom_result>{"verdict":"ok","confidence":"very"}</warroom_result>`);
  assert.equal(plain?.confidence, undefined);
  assert.equal(plain?.flipIf, undefined);
  assert.equal(plain?.rejected, undefined);
});

test("report extras and host note render only what exists; low confidence asks the host to confirm first", () => {
  const base = { verdict: "v", consensus: [], disputes: [], actions: [], metrics: [], charts: [], structured: true };
  assert.equal(warroomReportExtras(base), "");
  assert.equal(warroomHostConfidenceNote(base), "");
  const extras = warroomReportExtras({ ...base, confidence: "medium", earlyConsensus: true, flipIf: ["成本翻倍"], rejected: [{ option: "外包", reason: "太貴" }] });
  assert.match(extras, /信心程度\*\*：中/);
  assert.match(extras, /省略反駁輪/);
  assert.match(extras, /## 什麼會推翻這個結論\n- 成本翻倍/);
  assert.match(extras, /\*\*外包\*\*：太貴/);
  assert.match(warroomHostConfidenceNote({ ...base, confidence: "low" }), /先跟使用者確認/);
  assert.doesNotMatch(warroomHostConfidenceNote({ ...base, confidence: "high" }), /確認/);
});

test("new war room prompts and report pieces are fully translated in English mode", async () => {
  const { setLang } = await import("../src/i18n.js");
  setLang("en");
  try {
    const cjk = /[\u4e00-\u9fff]/;
    assert.doesNotMatch(warroomSynthesisPrompt({ topic: "x", debate: "d", peerCount: 3, rounds: 2, context: "ctx" }), cjk);
    assert.doesNotMatch(warroomSynthesisPrompt({ topic: "x", debate: "d", peerCount: 3, rounds: 2, earlyConsensus: true }), cjk);
    assert.doesNotMatch(warroomSynthesisPrompt({ topic: "x", debate: "d", peerCount: 2, rounds: 1 }), cjk);
    assert.doesNotMatch(warroomOpeningPrompt({ topic: "x", stanceBrief: "b", context: "ctx" }), cjk);
    assert.doesNotMatch(warroomRebuttalPrompt({ stanceBrief: "b", othersDebate: "o" }), cjk);
    const base = { verdict: "v", consensus: [], disputes: [], actions: [], metrics: [], charts: [], structured: true };
    assert.doesNotMatch(warroomReportExtras({ ...base, confidence: "low", earlyConsensus: true, flipIf: ["a"], rejected: [{ option: "b", reason: "c" }] }), cjk);
    assert.doesNotMatch(warroomHostConfidenceNote({ ...base, confidence: "low" }), cjk);
    assert.doesNotMatch(warroomContextBrief({ hostName: "A", workspacePath: "/p", events: [{ type: "user_message", text: "hi" }] }), cjk);
  } finally {
    setLang("zh");
  }
});
