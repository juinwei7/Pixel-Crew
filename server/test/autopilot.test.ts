import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOPILOT_DEFAULT_STEPS,
  AUTOPILOT_MAX_STEPS,
  AUTOPILOT_MIN_STEPS,
  autopilotNextPrompt,
  clampAutopilotSteps,
  explainAutopilotFailure,
  parseAutopilotDecision,
} from "../src/autopilot.js";

test("clampAutopilotSteps bounds to [MIN, MAX] and defaults on garbage", () => {
  assert.equal(clampAutopilotSteps(undefined), AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampAutopilotSteps("15"), AUTOPILOT_DEFAULT_STEPS); // non-number → default
  assert.equal(clampAutopilotSteps(NaN), AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampAutopilotSteps(0), AUTOPILOT_MIN_STEPS); // architected floor: never 0 steps
  assert.equal(clampAutopilotSteps(-5), AUTOPILOT_MIN_STEPS);
  assert.equal(clampAutopilotSteps(9999), AUTOPILOT_MAX_STEPS); // can't architect around the ceiling
  assert.equal(clampAutopilotSteps(7.9), 7); // floored
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
