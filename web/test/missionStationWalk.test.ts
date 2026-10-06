import assert from "node:assert/strict";
import test from "node:test";
import { missionStationOverride, missionToolStation } from "../src/game/missionScene.js";

// 回歸：Mission（部門交辦／BOSS 交辦）走獨立的 mission runner，工具事件只進 mission.executionEvents、
// 不進 worker 自己的 turns——worker.character.station 永遠是 home、turns 裡也沒有執行中的工具，
// 舊的 missionStationOverride 只看 worker.turns，所以 Mission 中的 NPC 永遠坐在自己桌前不會走去工作站。
// 實際資料（cockpit.sqlite）：tool_call_start 與 tool_call_result 幾乎同一刻到達（0.0s），
// 所以站位必須「黏住」到該輪 turn_end，而不是只在工具執行中那一瞬間。

const W = "w1";
const missionWorker = { id: W, busy: true, character: { station: "home" }, turns: [] };
const ev = (type: string, extra: Record<string, unknown> = {}, workerId = W) => ({ workerId, event: { type, ...extra } });

test("mission NPC walks to the station of the tool it just used, even after the result came back", () => {
  const events = [
    ev("user_message", { text: "步驟 1" }),
    ev("thinking_delta", { text: "…" }),
    ev("tool_call_start", { id: "t1", name: "WebSearch", input: { query: "x" } }),
    ev("tool_call_result", { id: "t1", output: "ok", isError: false }),
    ev("text_delta", { text: "查到了" }),
  ];
  assert.equal(missionStationOverride(missionWorker, events), "web");
  // 下一個工具換站
  const more = [...events, ev("tool_call_start", { id: "t2", name: "Bash", input: { command: "ls" } }), ev("tool_call_result", { id: "t2", output: "" })];
  assert.equal(missionStationOverride(missionWorker, more), "terminal");
});

test("mission NPC returns to the desk at turn end / before the first tool / for other workers' tools", () => {
  const used = [ev("user_message"), ev("tool_call_start", { id: "t1", name: "Read", input: {} }), ev("tool_call_result", { id: "t1" })];
  assert.equal(missionToolStation(used, W), "books");
  assert.equal(missionStationOverride(missionWorker, [...used, ev("turn_end")]), null);
  assert.equal(missionStationOverride(missionWorker, [...used, ev("error", { message: "x" })]), null);
  // 新的一輪開始、還沒用工具 → 在座位思考
  assert.equal(missionStationOverride(missionWorker, [...used, ev("turn_end"), ev("user_message")]), null);
  // 別人的工具不會把我拉走；別人的事件也不會打斷我的站位
  assert.equal(missionStationOverride(missionWorker, [ev("user_message"), ev("tool_call_start", { name: "Edit" }, "w2")]), null);
  assert.equal(missionStationOverride(missionWorker, [...used, ev("turn_end", {}, "w2"), ev("tool_call_start", { name: "Edit" }, "w2")]), "books");
  // 不 busy／server 已給站位 → 不覆寫
  assert.equal(missionStationOverride({ ...missionWorker, busy: false }, used), null);
  assert.equal(missionStationOverride({ ...missionWorker, character: { station: "code" } }, used), null);
  // 沒傳 executionEvents（一般對話路徑）維持舊行為
  assert.equal(missionStationOverride(missionWorker), null);
});
