import assert from "node:assert/strict";
import test from "node:test";
import {
  latestOwnerInstruction,
  mergeWorkerAutopilotPlan,
  normalizeWorkerAutopilotPlan,
  normalizeWorkerAutopilotStates,
  workerAutopilotIdleStreak,
  workerAutopilotStepActivity,
  WORKER_AUTOPILOT_IDLE_STOP,
} from "../src/workerAutopilot.js";

// ── 固定循環目標：owner 開循環時的原話，模型不能改寫 ─────────────────────────
test("mergeWorkerAutopilotPlan：模型改寫或擴大 goal 一律無效，保留 owner 原話", () => {
  const prev = normalizeWorkerAutopilotPlan({ goal: "把名牌整合做完", updatedRound: 1 });
  const { plan } = mergeWorkerAutopilotPlan(prev, { goal: "名牌整合＋修配件＋盤點介面＋提升有趣度", toTry: [{ text: "修配件", need: "讀碼" }] }, 2);
  assert.equal(plan.goal, "把名牌整合做完");
  assert.equal(plan.toTry[0].text, "修配件"); // 新方向進待試，不進目標
});

test("latestOwnerInstruction：取最近一則真人指示，略過通知、系統訊息與循環自己送的指示", () => {
  const history = [
    { type: "user_message", text: "很久以前的舊任務" },
    { type: "turn_end" },
    { type: "user_message", text: "把 README 翻成英文" },
    { type: "turn_end" },
    { type: "user_message", text: "🧠 自動換腦完成", system: true },
    { type: "user_message", text: "⏸ 循環通知", notice: true },
    { type: "user_message", text: "🔁（自動循環）校對第二段", autopilot: true },
  ];
  assert.equal(latestOwnerInstruction(history), "把 README 翻成英文");
  assert.equal(latestOwnerInstruction([]), null);
});

test("normalizeWorkerAutopilotStates：目標跨重啟保留，舊檔沒有 goal 也照常還原", () => {
  const out = normalizeWorkerAutopilotStates({
    a: { stepsRemaining: 3, deadlineAt: null, proactive: true, goal: "  做完翻譯  " },
    b: { stepsRemaining: 2, deadlineAt: null, proactive: false },
  });
  assert.equal(out.a.goal, "做完翻譯");
  assert.equal("goal" in out.b, false);
});

// ── 空轉偵測：伺服器實測每步有沒有產出 ───────────────────────────────────
const auto = (text: string, at: number) => ({ type: "user_message", text: `🔁（自動循環）${text}`, autopilot: true, at });
const end = (at: number) => ({ type: "turn_end", at });
const tool = (name: string, input: unknown = {}) => ({ type: "tool_call_start", name, input });

test("workerAutopilotStepActivity：改檔、commit、查資料都算產出；只讀檔／跑測試不算", () => {
  const steps = workerAutopilotStepActivity([
    auto("改檔", 1), tool("Edit"), end(2),
    auto("提交", 3), tool("Bash", { command: "git add -A && git commit -m x" }), end(4),
    auto("查資料", 5), tool("WebSearch"), end(6),
    auto("重驗", 7), tool("Read"), tool("Bash", { command: "npm test" }), end(8),
  ]);
  assert.deepEqual(steps.map((s) => [s.wrote, s.researched]), [[true, false], [true, false], [false, true], [false, false]]);
  assert.equal(steps[3].startAt, 7);
  assert.equal(steps[3].endAt, 8);
});

test("workerAutopilotIdleStreak：連續沒產出才累計，遇到產出或 owner 插話就中斷", () => {
  const idle = workerAutopilotStepActivity([
    auto("做事", 1), tool("Write"), end(2),
    auto("重驗", 3), tool("Read"), end(4),
    auto("再重驗", 5), tool("Grep"), end(6),
  ]);
  assert.equal(workerAutopilotIdleStreak(idle), 2);
  assert.ok(workerAutopilotIdleStreak(idle) >= WORKER_AUTOPILOT_IDLE_STOP);

  const ownerBreak = workerAutopilotStepActivity([
    auto("重驗", 1), end(2),
    { type: "user_message", text: "改做 B", at: 3 }, end(4),
    auto("重驗", 5), end(6),
  ]);
  assert.equal(workerAutopilotIdleStreak(ownerBreak), 1);

  // Bash 跑腳本產檔不會出現 Write 工具：呼叫端用工作區實測補上
  const scripted = workerAutopilotStepActivity([auto("跑回測", 1), tool("Bash", { command: "python backtest.py" }), end(2)]);
  assert.equal(workerAutopilotIdleStreak(scripted), 1);
  assert.equal(workerAutopilotIdleStreak(scripted, () => true), 0);

  // 還沒跑完的步驟不算
  assert.equal(workerAutopilotIdleStreak(workerAutopilotStepActivity([auto("進行中", 1)])), 0);
});
