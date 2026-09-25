import assert from "node:assert/strict";
import test from "node:test";
import { latestMissionSpeech, missionStationOverride, runningToolFor } from "../src/game/missionScene.js";

function workerWithTool(name: string, input: unknown, busy = true, station = "home") {
  return {
    busy,
    character: { station },
    turns: [{ items: [
      { kind: "text", status: "done" },
      { kind: "tool_call", status: "running", name, input },
    ] }],
  };
}

test("runningToolFor reads the last running tool_call of the last turn", () => {
  assert.deepEqual(runningToolFor(workerWithTool("WebSearch", { query: "扶手" })), { name: "WebSearch", input: { query: "扶手" } });
  assert.equal(runningToolFor({ turns: [] }), null);
  assert.equal(runningToolFor({ turns: [{ items: [{ kind: "tool_call", status: "completed", name: "Bash" }] }] }), null);
});

test("missionStationOverride walks a busy home-bound worker to the tool's station, and only then", () => {
  assert.equal(missionStationOverride(workerWithTool("WebSearch", { query: "x" })), "web");
  assert.equal(missionStationOverride(workerWithTool("Bash", { command: "ls" })), "terminal");
  assert.equal(missionStationOverride(workerWithTool("Edit", {})), "code");
  // 不 busy／server 已給站位／沒有工具在跑 → 一律不覆寫，尊重 server。
  assert.equal(missionStationOverride(workerWithTool("Bash", {}, false)), null);
  assert.equal(missionStationOverride(workerWithTool("Bash", {}, true, "web")), null);
  assert.equal(missionStationOverride({ busy: true, character: { station: "home" }, turns: [] }), null);
  // 推導結果是 desk/home 這種「沒資訊量」的站位就不動——站在原桌即可。
  assert.equal(missionStationOverride(workerWithTool("SomeUnknownTool", {})), null);
});

test("latestMissionSpeech collects the assignee's trailing text_delta run and trims it into a bubble", () => {
  const events = [
    { workerId: "a", event: { type: "text_delta", text: "我先盤點" } },
    { workerId: "a", event: { type: "thinking_delta", text: "（雜訊）" } },
    { workerId: "a", event: { type: "text_delta", text: "浴室扶手的" } },
    { workerId: "b", event: { type: "text_delta", text: "我補充一下" } },
    { workerId: "a", event: { type: "text_delta", text: "**風險**：門檻" } },
    { workerId: "a", event: { type: "text_delta", text: "與地毯要優先處理" } },
  ];
  // 只收最後一段連續發言（b 的插話之後），markdown 記號被拆掉、空白正規化。
  assert.equal(latestMissionSpeech(events, "a"), "風險：門檻與地毯要優先處理");
  // b 的最新一句
  assert.equal(latestMissionSpeech(events, "b"), "我補充一下");
  // 超長截尾
  const long = [{ workerId: "a", event: { type: "text_delta", text: "甲".repeat(200) } }];
  const bubble = latestMissionSpeech(long, "a", 20);
  assert.equal(bubble, `…${"甲".repeat(20)}`);
  // 沒講過話／沒有事件 → null
  assert.equal(latestMissionSpeech(events, "c"), null);
  assert.equal(latestMissionSpeech([], "a"), null);
  assert.equal(latestMissionSpeech(undefined, "a"), null);
});
