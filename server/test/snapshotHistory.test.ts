import assert from "node:assert/strict";
import test from "node:test";

import { snapshotHistory, SNAPSHOT_HARD_MAX_EVENTS, SNAPSHOT_MAX_EVENTS, SNAPSHOT_MIN_TURNS, trimRetainedHistory } from "../src/snapshotHistory.js";
import type { RunnerEvent } from "../src/claudeRunner.js";

// 造一個「turn」：user_message 開頭，接著 n 筆 text_delta。
function turn(command: string, deltas: number): RunnerEvent[] {
  const events: RunnerEvent[] = [{ type: "user_message", text: command } as RunnerEvent];
  for (let i = 0; i < deltas; i++) events.push({ type: "text_delta", text: "x" } as RunnerEvent);
  return events;
}

// 換腦系統卡：system:true 的 user_message（換腦宣告／蒸餾心法／換腦完成那種）。
function systemCard(command: string): RunnerEvent[] {
  return [{ type: "user_message", text: command, system: true } as RunnerEvent];
}

function commandsOf(events: RunnerEvent[]): string[] {
  return events.filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text);
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

// 核心回歸（owner 回報「換腦後前面日誌被蓋掉」）：換腦會在最近 2 個真實結果之後連插數張 system
// 卡。若 floor 把 system 卡也算進「最近 N 個 turn」，重啟後的 snapshot 就只剩換腦卡、使用者真正的
// 工作結果被擠出。floor 只數非系統 turn，故 2 個真實結果 t1/t2 必須都留在 snapshot 裡。
test("換腦系統卡不佔真實結果名額：最近 N 個真實工作結果不會被換腦卡擠出 snapshot", () => {
  const big = Math.floor(SNAPSHOT_MAX_EVENTS * 0.7); // 兩個真實 turn 相加 > 視窗，逼 floor 生效
  const history = [
    ...turn("真實結果-1", big),
    ...turn("真實結果-2", big),
    ...systemCard("🧠 即將換腦，請寫交接摘要"),
    ...systemCard("🧠 換腦蒸餾出一條做事心法"),
    ...systemCard("🧠 自動換腦完成：交接摘要已送進全新工作階段"),
  ];
  const out = snapshotHistory(history);
  const commands = commandsOf(out);
  assert.ok(commands.includes("真實結果-1"), `最舊的真實結果必須保留，實際：${commands.join(" / ")}`);
  assert.ok(commands.includes("真實結果-2"), `最新的真實結果必須保留，實際：${commands.join(" / ")}`);
  assert.equal(out[0].type, "user_message", "切點落在某個 turn 開頭");
});

test("完全沒有 user_message（只有孤兒事件）時保留尾段、不爆量，並補一張開頭卡讓前端開得出 turn", () => {
  const history: RunnerEvent[] = [];
  for (let i = 0; i < SNAPSHOT_MAX_EVENTS + 300; i++) history.push({ type: "text_delta", text: "x" } as RunnerEvent);
  const out = snapshotHistory(history);
  assert.equal(out.length, SNAPSHOT_MAX_EVENTS);
  // 重啟後從 SQLite 載回的超長 turn 可能已沒有 user_message：沒有開頭卡，前端會渲染 0 個 turn。
  assert.equal(out[0].type, "user_message");
  assert.equal(commandsOf(out).length, 1);
});

// 核心回歸：上限要真的是上限。舊版 start = min(視窗邊界, 最近 N turn 起點) 可以退回 index 0，
// 於是整段歷史（最多 MAX_HISTORY=2000 筆）照送，初始 snapshot 又脹回十幾 MB。
test("退到 turn 邊界也不得超過硬上限", () => {
  // 兩個各自遠大於視窗的 turn：舊版會退到第一個 turn 的起點＝整段都送。
  const history = [...turn("a", SNAPSHOT_HARD_MAX_EVENTS), ...turn("b", SNAPSHOT_HARD_MAX_EVENTS)];
  const out = snapshotHistory(history);
  assert.ok(out.length <= SNAPSHOT_HARD_MAX_EVENTS, `不得超過硬上限，實際 ${out.length}`);
  assert.equal(out[0].type, "user_message", "切點仍要落在 turn 開頭，日誌才不空白");
});

test("單一超長 turn 超過硬上限時，保留 user_message ＋尾段（有界且不空白）", () => {
  const history = turn("huge", SNAPSHOT_HARD_MAX_EVENTS + 500);
  const out = snapshotHistory(history);
  assert.ok(out.length <= SNAPSHOT_HARD_MAX_EVENTS, `不得超過硬上限，實際 ${out.length}`);
  assert.equal(out[0].type, "user_message", "開頭必須是 user_message，否則前端整個日誌空白");
});

// 保留歷史裁切（record() 的 MAX_HISTORY）：單一 turn 超過上限時，舊版會把它的 user_message
// 一起丟掉，snapshot 只剩孤兒事件。
test("trimRetainedHistory 在 turn 還開著時把它的 user_message 釘在開頭", () => {
  const history = turn("huge", 10);
  for (let i = 0; i < 5; i++) {
    history.push({ type: "text_delta", text: "y" } as RunnerEvent);
    trimRetainedHistory(history, 8);
    assert.equal(history.length, 8);
    assert.equal(history[0].type, "user_message");
    assert.deepEqual(commandsOf(history), ["huge"]);
  }
  assert.equal((history.at(-1) as { text: string }).text, "y", "最新的事件一定留著");
});

test("trimRetainedHistory 不會替已收尾的 turn 留開頭（否則它會被當成沒結束）", () => {
  const history: RunnerEvent[] = [
    ...turn("a", 3),
    { type: "turn_end", resultText: "", costUsd: 0, durationMs: 0, isError: false, permissionDenials: [] } as RunnerEvent,
    ...turn("b", 3),
  ];
  // 丟到 a 的 turn_end 剛好是保留段開頭：a 已收尾，照常丟掉它的開頭。
  trimRetainedHistory(history, history.length - 4);
  assert.equal(history[0].type, "turn_end");
  assert.deepEqual(commandsOf(history), ["b"]);
  // 再丟一筆：保留段從 b 的 user_message 開始，本來就是 turn 邊界。
  trimRetainedHistory(history, history.length - 1);
  assert.deepEqual(commandsOf(history), ["b"]);
  assert.equal(history[0].type, "user_message");
});

test("trimRetainedHistory 只認真的 turn 開頭：notice 不算，結束後的孤兒事件也不補開頭", () => {
  const history: RunnerEvent[] = [
    ...turn("work", 2),
    { type: "user_message", text: "🔎 查證", notice: true } as RunnerEvent,
    { type: "text_delta", text: "z" } as RunnerEvent,
    { type: "text_delta", text: "z" } as RunnerEvent,
  ];
  trimRetainedHistory(history, 3); // 切掉 work、兩筆 delta 與 notice
  assert.deepEqual(commandsOf(history), ["work"]);
  assert.equal(history.length, 3);
  const ended: RunnerEvent[] = [
    ...turn("done", 1),
    { type: "error", message: "boom" } as RunnerEvent,
    { type: "text_delta", text: "late" } as RunnerEvent,
    { type: "text_delta", text: "late" } as RunnerEvent,
  ];
  trimRetainedHistory(ended, 2);
  assert.deepEqual(commandsOf(ended), []);
  assert.equal(ended.length, 2);
});

test("trimRetainedHistory 沒超過上限時不動", () => {
  const history = turn("a", 3);
  trimRetainedHistory(history, 10);
  assert.equal(history.length, 4);
});
