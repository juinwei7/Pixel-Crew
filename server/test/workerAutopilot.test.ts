import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_AUTOPILOT_DEFAULT_STEPS,
  WORKER_AUTOPILOT_MAX_MINUTES,
  WORKER_AUTOPILOT_MAX_STEPS,
  WORKER_AUTOPILOT_MIN_STEPS,
  clampWorkerAutopilotMinutes,
  clampWorkerAutopilotSteps,
  explainWorkerAutopilotFailure,
  normalizeWorkerAutopilotStates,
  parseWorkerAutopilotDecision,
  workerAutopilotNextPrompt,
} from "../src/workerAutopilot.js";

test("clampWorkerAutopilotSteps bounds to [MIN, MAX] and defaults on garbage", () => {
  assert.equal(clampWorkerAutopilotSteps(undefined), WORKER_AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampWorkerAutopilotSteps("abc"), WORKER_AUTOPILOT_DEFAULT_STEPS);
  assert.equal(clampWorkerAutopilotSteps(0), WORKER_AUTOPILOT_MIN_STEPS);
  assert.equal(clampWorkerAutopilotSteps(9999), WORKER_AUTOPILOT_MAX_STEPS);
  assert.equal(clampWorkerAutopilotSteps(7.9), 7);
});

test("clampWorkerAutopilotMinutes: blank/garbage/≤0 → null, positives floored and capped", () => {
  assert.equal(clampWorkerAutopilotMinutes(undefined), null);
  assert.equal(clampWorkerAutopilotMinutes("x"), null);
  assert.equal(clampWorkerAutopilotMinutes(0), null);
  assert.equal(clampWorkerAutopilotMinutes(-5), null);
  assert.equal(clampWorkerAutopilotMinutes(90.7), 90);
  assert.equal(clampWorkerAutopilotMinutes(999999), WORKER_AUTOPILOT_MAX_MINUTES);
});

test("prompt carries worker identity, recent turns, and strict STOP framing", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "總管小揮",
    role: "總指揮",
    workspaceLabel: "d:/測試",
    turns: [
      { instruction: "整理報告", result: "已完成初稿" },
      { instruction: "補上結論" },
    ],
    stepsRemaining: 3,
  });
  assert.match(prompt, /總管小揮/);
  assert.match(prompt, /總指揮/);
  assert.match(prompt, /整理報告/);
  assert.match(prompt, /已完成初稿/);
  assert.match(prompt, /STOP readily/);
  assert.match(prompt, /steps remaining after this one: 3/i);
  assert.match(prompt, /<worker_autopilot_next>/);
});

test("parses continue and stop decisions; bounds fields", () => {
  const cont = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"驗證剛寫的檔案內容","reason":"接續驗證"}</worker_autopilot_next>`,
  );
  assert.deepEqual(cont, { action: "continue", instruction: "驗證剛寫的檔案內容", reason: "接續驗證" });

  const stop = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"stop","reason":"工作已收尾"}</worker_autopilot_next>`,
  );
  assert.deepEqual(stop, { action: "stop", reason: "工作已收尾" });
});

test("empty instruction degrades to stop; malformed output → null with explanation", () => {
  const empty = parseWorkerAutopilotDecision(
    `<worker_autopilot_next>{"action":"continue","instruction":"  ","reason":"?"}</worker_autopilot_next>`,
  );
  assert.equal(empty?.action, "stop");

  assert.equal(parseWorkerAutopilotDecision("no block"), null);
  assert.match(explainWorkerAutopilotFailure("no block") ?? "", /Missing a <worker_autopilot_next>/);
  assert.match(explainWorkerAutopilotFailure(`<worker_autopilot_next>{bad}</worker_autopilot_next>`) ?? "", /did not parse/);
  assert.match(explainWorkerAutopilotFailure(`<worker_autopilot_next>{"action":"dance"}</worker_autopilot_next>`) ?? "", /"action" must be exactly/);
});

test("normalizeWorkerAutopilotStates drops garbage rows and clamps survivors", () => {
  const restored = normalizeWorkerAutopilotStates({
    good: { stepsRemaining: 3, deadlineAt: null },
    tooMany: { stepsRemaining: 9999, deadlineAt: null },
    zero: { stepsRemaining: 0, deadlineAt: null },
    junk: "not an object",
    badSteps: { stepsRemaining: "x", deadlineAt: null },
  });
  assert.deepEqual(Object.keys(restored).sort(), ["good", "tooMany"]);
  assert.equal(restored.good.stepsRemaining, 3);
  assert.equal(restored.tooMany.stepsRemaining, WORKER_AUTOPILOT_MAX_STEPS);
  assert.deepEqual(normalizeWorkerAutopilotStates(null), {});
  assert.deepEqual(normalizeWorkerAutopilotStates([1, 2]), {});
});
