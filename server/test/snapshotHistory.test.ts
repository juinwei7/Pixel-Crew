import assert from "node:assert/strict";
import test from "node:test";

import { snapshotHistory, SNAPSHOT_MAX_EVENTS, SNAPSHOT_MIN_TURNS } from "../src/snapshotHistory.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

// 造一個「turn」：user_message 開頭，接著 n 筆 text_delta。
function turn(command: string, deltas: number): RunnerEvent[] {
  const events: RunnerEvent[] = [{ type: "user_message", text: command } as RunnerEvent];
  for (let i = 0; i < deltas; i++) events.push({ type: "text_delta", text: "x" } as RunnerEvent);
  return events;
}

function hasUserMessage(events: RunnerEvent[]): boolean {
  return events.some((e) => e.type === "user_message");
}

test("小於視窗上限：原封送出全部", () => {
  const history = [...turn("a", 3), ...turn("b", 3)];
  const out = snapshotHistory(history);
  assert.equal(out.length, history.length);
  assert.equal(out[0].type, "user_message");
});

// 核心回歸：單一超長 turn（event 數 > 視窗上限）時，舊版會從半截切、開頭沒有 user_message，
// 前端把孤兒事件全略過→日誌整個空白。新版必須保證切點落在 user_message、日誌不空白。
test("單一超長 turn 也絕不切出無 user_message 的孤兒段（日誌不空白）", () => {
  const history = turn("huge", SNAPSHOT_MAX_EVENTS + 500); // 一個 turn 就超過視窗
  const out = snapshotHistory(history);
  assert.ok(hasUserMessage(out), "切出來的片段必須含 user_message，否則前端整個日誌空白");
  assert.equal(out[0].type, "user_message", "切點必須落在 turn 開頭");
});

test("超長歷史至少保留最近 SNAPSHOT_MIN_TURNS 個完整 turn", () => {
  // 每個 turn 都很長，湊到總量遠超視窗，且最後兩個 turn 各自 < 視窗但相加 > 視窗。
  const big = Math.floor(SNAPSHOT_MAX_EVENTS * 0.7);
  const history = [...turn("t1", big), ...turn("t2", big), ...turn("t3", big)];
  const out = snapshotHistory(history);
  const userMsgs = out.filter((e) => e.type === "user_message").length;
  assert.ok(userMsgs >= SNAPSHOT_MIN_TURNS, `至少保留 ${SNAPSHOT_MIN_TURNS} 個完整 turn，實際 ${userMsgs}`);
  assert.equal(out[0].type, "user_message", "切點落在某個 turn 開頭");
});

test("視窗內有多個小 turn 時，盡量多保留（不只 2 個）", () => {
  // 一堆小 turn，最後 SNAPSHOT_MAX_EVENTS 內可容納遠多於 2 個 turn。
  const history: RunnerEvent[] = [];
  for (let i = 0; i < 40; i++) history.push(...turn(`t${i}`, 30));
  const out = snapshotHistory(history);
  const userMsgs = out.filter((e) => e.type === "user_message").length;
  assert.ok(userMsgs > SNAPSHOT_MIN_TURNS, `視窗內應保留多於 ${SNAPSHOT_MIN_TURNS} 個 turn，實際 ${userMsgs}`);
  assert.ok(out.length <= SNAPSHOT_MAX_EVENTS + 30, "大致不超過視窗上限（對齊 turn 邊界容許小幅溢出）");
});

test("完全沒有 user_message（只有孤兒事件）時保留尾段、不爆量", () => {
  const history: RunnerEvent[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_EVENTS + 300; i++) history.push({ type: "text_delta", text: "x" } as RunnerEvent);
  const out = snapshotHistory(history);
  assert.equal(out.length, SNAPSHOT_MAX_EVENTS);
});
