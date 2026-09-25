import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
  autopilotAnswerPrompt,
  autopilotResolvePrompt,
  explainAutopilotAnswerFailure,
  explainAutopilotResolveFailure,
  parseAutopilotAnswerDecision,
  parseAutopilotResolveDecision,
} from "../src/autopilotResolve.js";

const promptInput = {
  objective: "對主資料表執行實體解析清理",
  stageTitle: "執行交辦",
  departmentName: "臨時團隊·主資料清理",
  attentionReason: "review_inconclusive",
  missionError: "Review 無法確認通過，需要你補充資訊或重新檢查",
  stepTitle: "200 對金標樣本驗證",
  stepKind: "review",
  reviewSummary: '{"verdict":"inconclusive","summary":"缺真實主資料表"}',
  attemptNumber: 1,
  maxAttempts: AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
};

test("autopilotResolvePrompt embeds context, attempt counter, and all four output forms", () => {
  const prompt = autopilotResolvePrompt(promptInput);
  assert.match(prompt, /實體解析清理/);
  assert.match(prompt, /臨時團隊·主資料清理/);
  assert.match(prompt, /review_inconclusive/);
  assert.match(prompt, /缺真實主資料表/);
  assert.match(prompt, new RegExp(`attempt 1 of ${AUTOPILOT_RESOLVE_MAX_ATTEMPTS}`));
  // 護欄必須明寫在 prompt 裡：絕不捏造資料，需要老闆的事選 wait。
  assert.match(prompt, /NEVER fabricate/);
  for (const action of ["retry_execute", "accept_risk", '"retry"', '"wait"']) assert.ok(prompt.includes(action), action);
  assert.match(prompt, /<autopilot_resolve>/);
});

test("parse: four valid actions round-trip; guidance/reason are bounded", () => {
  assert.deepEqual(
    parseAutopilotResolveDecision('<autopilot_resolve>{"action":"retry"}</autopilot_resolve>'),
    { action: "retry", guidance: "" },
  );
  assert.deepEqual(
    parseAutopilotResolveDecision('<autopilot_resolve>{"action":"retry_execute","guidance":"縮小範圍，用現有 5 對樣本誠實結案"}</autopilot_resolve>'),
    { action: "retry_execute", guidance: "縮小範圍，用現有 5 對樣本誠實結案" },
  );
  assert.deepEqual(
    parseAutopilotResolveDecision('<autopilot_resolve>{"action":"accept_risk","guidance":"接受小樣本不確定性，僅供內部參考"}</autopilot_resolve>'),
    { action: "accept_risk", guidance: "接受小樣本不確定性，僅供內部參考" },
  );
  assert.deepEqual(
    parseAutopilotResolveDecision('<autopilot_resolve>{"action":"wait","reason":"需要老闆提供真實資料表"}</autopilot_resolve>'),
    { action: "wait", reason: "需要老闆提供真實資料表" },
  );
  // guidance 超長會被截到 2000（對齊 /api/missions/:id/resolve 的 collaborationText 上限）。
  const long = parseAutopilotResolveDecision(`<autopilot_resolve>{"action":"retry_execute","guidance":"${"甲".repeat(3000)}"}</autopilot_resolve>`);
  assert.equal(long?.action, "retry_execute");
  assert.equal((long as { guidance: string }).guidance.length, 2000);
});

test("parse: retry_execute/accept_risk without guidance degrade to wait (never blind-rerun or silently accept risk)", () => {
  const rerun = parseAutopilotResolveDecision('<autopilot_resolve>{"action":"retry_execute"}</autopilot_resolve>');
  assert.equal(rerun?.action, "wait");
  const risky = parseAutopilotResolveDecision('<autopilot_resolve>{"action":"accept_risk","guidance":"  "}</autopilot_resolve>');
  assert.equal(risky?.action, "wait");
});

test("answer prompt embeds the question, conversation, attempt counter, and both output forms", () => {
  const prompt = autopilotAnswerPrompt({
    objective: "為高齡住家做防跌改造",
    question: "無法提供用藥清單時，是否先產出可自行填寫的範本版本？",
    conversation: [
      { role: "boss", text: "執行防跌改造專案" },
      { role: "decision_model", text: "請提供用藥清單與現場照片" },
    ],
    attemptNumber: 1,
    maxAttempts: AUTOPILOT_RESOLVE_MAX_ATTEMPTS,
  });
  assert.match(prompt, /防跌改造/);
  assert.match(prompt, /範本版本/);
  assert.match(prompt, /請提供用藥清單與現場照片/);
  assert.match(prompt, new RegExp(`attempt 1 of ${AUTOPILOT_RESOLVE_MAX_ATTEMPTS}`));
  // 護欄必須明寫：不得捏造只有老闆知道的事實、不得核可花錢或不可逆的決定。
  assert.match(prompt, /NEVER fabricate facts only the boss can know/);
  assert.match(prompt, /self-serve fallback/);
  assert.match(prompt, /<autopilot_answer>/);
  assert.match(prompt, /"action":"wait"/);
});

test("answer parse: answer/wait round-trip; empty reply degrades to wait; junk explained", () => {
  assert.deepEqual(
    parseAutopilotAnswerDecision('<autopilot_answer>{"action":"answer","reply":"先產出可自行填寫的範本版；此為自動接手代答，可隨時修正"}</autopilot_answer>'),
    { action: "answer", reply: "先產出可自行填寫的範本版；此為自動接手代答，可隨時修正" },
  );
  assert.deepEqual(
    parseAutopilotAnswerDecision('<autopilot_answer>{"action":"wait","reason":"用藥內容只有老闆知道"}</autopilot_answer>'),
    { action: "wait", reason: "用藥內容只有老闆知道" },
  );
  // 空 reply 的 answer 一律降級成 wait，不把空話送進 discovery 對話。
  const empty = parseAutopilotAnswerDecision('<autopilot_answer>{"action":"answer","reply":"  "}</autopilot_answer>');
  assert.equal(empty?.action, "wait");
  assert.equal(parseAutopilotAnswerDecision("好，就這樣辦"), null);
  assert.match(explainAutopilotAnswerFailure("好，就這樣辦") ?? "", /Missing an <autopilot_answer>/);
  assert.equal(parseAutopilotAnswerDecision('<autopilot_answer>{"action":"approve"}</autopilot_answer>'), null);
  assert.match(explainAutopilotAnswerFailure('<autopilot_answer>{"action":"approve"}</autopilot_answer>') ?? "", /"action" must be exactly/);
  assert.equal(explainAutopilotAnswerFailure('<autopilot_answer>{"action":"wait","reason":"x"}</autopilot_answer>'), null);
});

test("parse: missing block / bad JSON / unknown action → null with a specific explanation", () => {
  assert.equal(parseAutopilotResolveDecision("我覺得可以繼續"), null);
  assert.match(explainAutopilotResolveFailure("我覺得可以繼續") ?? "", /Missing an <autopilot_resolve>/);
  assert.equal(parseAutopilotResolveDecision("<autopilot_resolve>{oops</autopilot_resolve>"), null);
  assert.match(explainAutopilotResolveFailure("<autopilot_resolve>{oops</autopilot_resolve>") ?? "", /did not parse/);
  assert.equal(parseAutopilotResolveDecision('<autopilot_resolve>{"action":"reassign","workerId":"x"}</autopilot_resolve>'), null);
  assert.match(explainAutopilotResolveFailure('<autopilot_resolve>{"action":"reassign","workerId":"x"}</autopilot_resolve>') ?? "", /"action" must be exactly/);
  assert.equal(parseAutopilotResolveDecision('<autopilot_resolve>["retry"]</autopilot_resolve>'), null);
  // 合法輸出不應被解釋成失敗。
  assert.equal(explainAutopilotResolveFailure('<autopilot_resolve>{"action":"retry"}</autopilot_resolve>'), null);
});
