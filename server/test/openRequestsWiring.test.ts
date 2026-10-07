// 接線整合測試：驗證未結案使用者請求帳本真的接進教練 prompt、決策解析、換腦交接三處。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workerAutopilotNextPrompt, parseWorkerAutopilotDecision } from "../src/workerAutopilot.js";
import { buildLocalHandoff, parseHandoffSummary, bootstrapPrompt, summaryMarkdown, withOpenUserRequests } from "../src/handoff.js";
import type { OpenUserRequest } from "../src/openRequests.js";

const openReq = (id: string, text: string): OpenUserRequest => ({ id, text, at: 1, status: "open" });

test("教練 prompt 帶入未結案請求時，含優先承接指令與該請求原文", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "小揮",
    role: null,
    workspaceLabel: "/ws",
    turns: [{ instruction: "上一步", result: "做了些事" }],
    stepsRemaining: 3,
    openRequests: [openReq("r1", "參考那支影片改善換腦")],
  });
  // 用資料區塊獨有字串判定（JSON 模板本身會提到欄位名，故不用純 "OPEN USER REQUESTS"）。
  assert.match(prompt, /OVERRIDE your ladder/);
  assert.match(prompt, /參考那支影片改善換腦/);
  assert.match(prompt, /PRIORITIZE/);
});

test("教練 prompt 無未結案請求時不出現資料區塊（不佔版面）", () => {
  const prompt = workerAutopilotNextPrompt({
    workerName: "小揮", role: null, workspaceLabel: "/ws",
    turns: [], stepsRemaining: 3,
  });
  // 模板仍會描述 resolvedRequestIds 欄位，但真人請求「資料區塊」的獨有字串不該出現。
  assert.doesNotMatch(prompt, /OVERRIDE your ladder/);
  assert.doesNotMatch(prompt, /from the real human owner/);
});

test("決策解析：continue 帶 resolvedRequestIds 會被解出", () => {
  const decision = parseWorkerAutopilotDecision(
    '<worker_autopilot_next>{"action":"continue","instruction":"接著做","reason":"推進","resolvedRequestIds":["r1","r2"]}</worker_autopilot_next>',
  );
  assert.equal(decision?.action, "continue");
  assert.deepEqual(decision?.resolvedRequestIds, ["r1", "r2"]);
});

test("決策解析：stop 帶 resolvedRequestIds 也解得出；空陣列則欄位省略", () => {
  const stopWith = parseWorkerAutopilotDecision(
    '<worker_autopilot_next>{"action":"stop","reason":"完成","resolvedRequestIds":["r1"]}</worker_autopilot_next>',
  );
  assert.deepEqual(stopWith?.resolvedRequestIds, ["r1"]);
  const stopEmpty = parseWorkerAutopilotDecision(
    '<worker_autopilot_next>{"action":"stop","reason":"完成","resolvedRequestIds":[]}</worker_autopilot_next>',
  );
  assert.equal(stopEmpty?.resolvedRequestIds, undefined);
});

test("換腦交接：buildLocalHandoff 逐字帶入未結案請求，goal 劫持不影響它", () => {
  const events: any[] = [
    { type: "user_message", text: "🔁（自動循環·剩 2 步）繼續爬階梯" }, // 循環的教練 prompt 當最後一則 user
    { type: "turn_end", resultText: "已完成一輪", isError: false },
  ];
  const summary = buildLocalHandoff(events, "", ["參考那支影片改善換腦"]);
  // goal 被循環 prompt 佔據（現況病徵），但 openUserRequests 仍逐字保留
  assert.match(summary.goal, /自動循環/);
  assert.deepEqual(summary.openUserRequests, ["參考那支影片改善換腦"]);
});

test("換腦交接：bootstrapPrompt 與 summaryMarkdown 都把未結案請求顯著呈現", () => {
  const summary = buildLocalHandoff([], "", ["把影片機制搬進 Pixel Crew"]);
  const boot = bootstrapPrompt(summary, [], "claude");
  assert.match(boot, /未結案使用者請求/);
  assert.match(boot, /把影片機制搬進 Pixel Crew/);
  const md = summaryMarkdown(summary);
  assert.match(md, /未結案使用者請求/);
  assert.match(md, /把影片機制搬進 Pixel Crew/);
});

test("換腦交接：parseHandoffSummary 能解析 openUserRequests 欄位（往返不丟）", () => {
  const raw = JSON.stringify({
    version: 1, goal: "目標", completed: [], currentState: [], decisions: [],
    changedFiles: [], constraints: [], pending: [], risks: [], nextActions: [],
    openUserRequests: ["未結案A", "未結案B"],
  });
  const parsed = parseHandoffSummary(raw);
  assert.deepEqual(parsed?.openUserRequests, ["未結案A", "未結案B"]);
});

test("換腦交接：帳本原文權威覆寫時仍遮蔽憑證、並受交接大綱尺寸上限約束", () => {
  const base = buildLocalHandoff([], "", []);
  const secret = "請用 api_key=sk-live-abcdefghijklmnopqrstuvwxyz 打這支 API";
  const huge = Array.from({ length: 12 }, (_, index) => `${index} ${"很長的請求".repeat(400)}`);
  const summary = withOpenUserRequests(base, [secret, ...huge]);
  assert.doesNotMatch(JSON.stringify(summary), /sk-live-abcdefghijklmnopqrstuvwxyz/);
  assert.match(summary.openUserRequests[0], /\[REDACTED\]/);
  assert.ok(JSON.stringify(summary).length <= 24_000, "交接大綱不能被原文撐破上限");
  assert.ok(summary.openUserRequests.every((item) => item.length <= 500));
});

test("帳本跟著對話走：/clear、換工作位置、刪除 NPC 都會清掉；交接只帶還算數的請求", () => {
  const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const block = (marker: string) => {
    const start = indexSource.indexOf(marker);
    assert.ok(start >= 0, `index.ts 找不到 ${marker}`);
    return indexSource.slice(start, indexSource.indexOf("\n}", start));
  };
  assert.match(block("function cleanWorkerAndAnnounce("), /clearCapturedRequests\(worker\.id\)/);
  assert.match(block('app.delete("/api/workers/:id"'), /clearCapturedRequests\(worker\.id\)/);
  assert.match(block('app.patch("/api/workers/:id/workspace"'), /clearCapturedRequests\(worker\.id\)/);
  const handoff = block("async function performProviderHandoff(");
  assert.match(handoff, /openRequestsForHandoff\(/);
  assert.match(handoff, /withOpenUserRequests\(summary, openRequestTexts\)/);
  assert.doesNotMatch(handoff, /summary\.openUserRequests = /, "直接塞原文會繞過遮蔽與尺寸上限");
});
