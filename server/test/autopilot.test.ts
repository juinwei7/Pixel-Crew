import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOPILOT_DEFAULT_STEPS,
  AUTOPILOT_MAX_MINUTES,
  AUTOPILOT_MAX_STEPS,
  AUTOPILOT_MIN_STEPS,
  autopilotNextPrompt,
  autopilotRepairPrompt,
  clampAutopilotMinutes,
  clampAutopilotSteps,
  decideWithFormatRepair,
  explainAutopilotFailure,
  parseAutopilotDecision,
} from "../src/autopilot.js";
import {
  explainAutopilotResolveFailure,
  parseAutopilotResolveDecision,
} from "../src/autopilotResolve.js";

test("clampAutopilotSteps bounds to [MIN, MAX] and defaults on garbage", () => {
  assert.equal(clampAutopilotSteps(undefined), AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampAutopilotSteps("15"), AUTOPILOT_DEFAULT_STEPS); // non-number → default
  assert.equal(clampAutopilotSteps(NaN), AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampAutopilotSteps(0), AUTOPILOT_MIN_STEPS); // architected floor: never 0 steps
  assert.equal(clampAutopilotSteps(-5), AUTOPILOT_MIN_STEPS);
  assert.equal(clampAutopilotSteps(9999), AUTOPILOT_MAX_STEPS); // can't architect around the ceiling
  assert.equal(clampAutopilotSteps(7.9), 7); // floored
});

test("clampAutopilotMinutes: blank/garbage/≤0 → null (no cap), positives floored & ceiling-bounded", () => {
  // 沒填或非法一律「不設時間上限」（回 null），別把 0 或負數變成一個秒殺的截止時刻。
  assert.equal(clampAutopilotMinutes(undefined), null);
  assert.equal(clampAutopilotMinutes("30"), null); // non-number → no cap
  assert.equal(clampAutopilotMinutes(NaN), null);
  assert.equal(clampAutopilotMinutes(0), null);
  assert.equal(clampAutopilotMinutes(-10), null);
  assert.equal(clampAutopilotMinutes(30), 30);
  assert.equal(clampAutopilotMinutes(45.9), 45); // floored
  assert.equal(clampAutopilotMinutes(999999), AUTOPILOT_MAX_MINUTES); // 24h ceiling
});

test("autopilotNextPrompt embeds history, workspace, remaining, and both output forms", () => {
  const prompt = autopilotNextPrompt({
    workspaceLabel: "量化交易",
    stepsRemaining: 4,
    history: [
      { objective: "建立資料下載器", report: "完成，抓到 5 年日線" },
      { objective: "寫回測框架" },
    ],
  });
  assert.match(prompt, /量化交易/);
  assert.match(prompt, /建立資料下載器/);
  assert.match(prompt, /抓到 5 年日線/);
  assert.match(prompt, /寫回測框架/);
  assert.match(prompt, /remaining after this one: 4/);
  // Must teach the model BOTH the task form and the stop form so it can bail.
  assert.match(prompt, /"action":"task"/);
  assert.match(prompt, /"action":"stop"/);
});

test("autopilotNextPrompt handles an empty history as the first step", () => {
  const prompt = autopilotNextPrompt({ workspaceLabel: "repo", stepsRemaining: 15, history: [] });
  assert.match(prompt, /第一步|first step/i);
});

test("parseAutopilotDecision reads a valid task decision", () => {
  const decision = parseAutopilotDecision('noise <autopilot_next>{"action":"task","objective":"補上單元測試","reason":"鎖住剛完成的功能"}</autopilot_next> trailing');
  assert.deepEqual(decision, { action: "task", objective: "補上單元測試", reason: "鎖住剛完成的功能" });
});

test("parseAutopilotDecision reads a stop decision", () => {
  const decision = parseAutopilotDecision('<autopilot_next>{"action":"stop","reason":"工作已完成"}</autopilot_next>');
  assert.deepEqual(decision, { action: "stop", reason: "工作已完成" });
});

test("parseAutopilotDecision downgrades an empty-objective task to a safe stop", () => {
  // A "task" with no objective must NOT flow an empty brief into the boss-task pipeline.
  const decision = parseAutopilotDecision('<autopilot_next>{"action":"task","objective":"   ","reason":"卡住了"}</autopilot_next>');
  assert.equal(decision?.action, "stop");
});

test("parseAutopilotDecision rejects malformed output", () => {
  assert.equal(parseAutopilotDecision("no marker at all"), null);
  assert.equal(parseAutopilotDecision("<autopilot_next>not json</autopilot_next>"), null);
  assert.equal(parseAutopilotDecision('<autopilot_next>{"action":"wat"}</autopilot_next>'), null);
  assert.equal(parseAutopilotDecision('<autopilot_next>["array"]</autopilot_next>'), null);
});

test("explainAutopilotFailure returns prose for bad output, null for good", () => {
  assert.match(String(explainAutopilotFailure("nothing here")), /Missing an <autopilot_next>/);
  assert.equal(explainAutopilotFailure('<autopilot_next>{"action":"stop","reason":"done"}</autopilot_next>'), null);
});

function scriptedRunner(replies: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    run: async (prompt: string) => {
      prompts.push(prompt);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected extra call");
      return reply;
    },
  };
}

const nextDecision = { tag: "autopilot_next" as const, parse: parseAutopilotDecision, explain: explainAutopilotFailure };

test("decideWithFormatRepair returns a valid first reply without a second call", async () => {
  const runner = scriptedRunner(['<autopilot_next>{"action":"stop","reason":"done"}</autopilot_next>']);
  const outcome = await decideWithFormatRepair({ prompt: "BASE", run: runner.run, ...nextDecision });
  assert.deepEqual(outcome, { ok: true, decision: { action: "stop", reason: "done" } });
  assert.equal(runner.prompts.length, 1);
});

test("decideWithFormatRepair re-asks once with the rejection reason and accepts the repair", async () => {
  // 以前一則格式抖動就把整條循環關掉（下一步那條還標成「正常結束」）。
  const runner = scriptedRunner([
    "下一步做 X 吧",
    '<autopilot_next>{"action":"task","objective":"補上 X 的測試","reason":"收尾"}</autopilot_next>',
  ]);
  const outcome = await decideWithFormatRepair({ prompt: "BASE", run: runner.run, ...nextDecision });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.decision.action, "task");
  assert.equal(runner.prompts.length, 2);
  assert.ok(runner.prompts[1].startsWith("BASE"));
  assert.match(runner.prompts[1], /Missing an <autopilot_next>/);
  assert.match(runner.prompts[1], /ONLY the single marked <autopilot_next> JSON block/);
});

test("decideWithFormatRepair reports a failure (not a decision) when the repair is malformed too", async () => {
  const runner = scriptedRunner([
    "nope",
    '<autopilot_resolve>{"action":"reassign"}</autopilot_resolve>',
  ]);
  const outcome = await decideWithFormatRepair({
    prompt: "BASE",
    tag: "autopilot_resolve",
    run: runner.run,
    parse: parseAutopilotResolveDecision,
    explain: explainAutopilotResolveFailure,
  });
  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.failure : "", /"action" must be exactly/);
  assert.equal(runner.prompts.length, 2);
});

test("decideWithFormatRepair lets a model-call error propagate to the caller", async () => {
  await assert.rejects(
    decideWithFormatRepair({ prompt: "BASE", run: async () => { throw new Error("timeout"); }, ...nextDecision }),
    /timeout/,
  );
});

test("autopilotRepairPrompt keeps the base prompt and names the expected block", () => {
  const repair = autopilotRepairPrompt("BASE", "bad json", "autopilot_answer");
  assert.ok(repair.startsWith("BASE"));
  assert.match(repair, /rejected: bad json/);
  assert.match(repair, /<autopilot_answer>/);
});
