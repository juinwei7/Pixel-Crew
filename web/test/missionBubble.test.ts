import assert from "node:assert/strict";
import test from "node:test";
import * as missionScene from "../src/game/missionScene.js";
import { friendlyToolSpeech } from "../src/workerState.js";
import type { CharacterState } from "../src/types.js";

// 回歸：Mission NPC 走到工作站（stationOverride）時，GameCanvas 跳過 mission 對話泡
// （missionTalking 要求 !stationOverride），結果泡泡／工作小窗顯示的是他「自己上一次聊天」的舊字。
// Mission 走獨立 runner，worker.character.speech 整場 Mission 都不會更新——所以 Mission 期間
// 泡泡必須改吃 mission.executionEvents 的「當下活動」：工具 → friendlyToolSpeech 短句；說話 → 最新發言。

type MissionCharacterFn = (
  worker: { id: string; busy: boolean; turns?: unknown[]; character: CharacterState },
  mission: { executionEvents?: Array<{ workerId: string; event: Record<string, unknown> }> } | null | undefined,
  isAssignee: boolean,
) => CharacterState | null;

const missionCharacter = (missionScene as unknown as { missionCharacter?: MissionCharacterFn }).missionCharacter;

const W = "w1";
const STALE = "上次私聊的舊回覆：好的我晚點看";
const character: CharacterState = { activity: "idle", mood: "neutral", station: "home", speech: STALE, bump: 0 };
const worker = { id: W, busy: true, turns: [], character };
const ev = (type: string, extra: Record<string, unknown> = {}, workerId = W) => ({ workerId, event: { type, ...extra } });

function call(...args: Parameters<MissionCharacterFn>): CharacterState | null {
  assert.equal(typeof missionCharacter, "function", "missionScene.missionCharacter must exist");
  return missionCharacter!(...args);
}

test("mission NPC at a tool station shows the current mission tool, never his stale own chat", () => {
  const input = { query: "台北 扶手 規範" };
  const events = [ev("user_message", { text: "步驟 1" }), ev("tool_call_start", { id: "t1", name: "WebSearch", input })];
  const shown = call(worker, { executionEvents: events }, true)!;
  assert.equal(shown.station, "web");
  assert.equal(shown.speech, friendlyToolSpeech("WebSearch", input));
  assert.notEqual(shown.speech, STALE);
  assert.equal(shown.activity, "working");
  assert.equal(shown.webQuery, "台北 扶手 規範"); // 上網查小窗要拿 Mission 的查詢字，不是舊的

  // 結果回來後仍黏在站點，泡泡仍是當下工具（不退回舊字）
  const afterResult = [...events, ev("tool_call_result", { id: "t1", output: "ok", isError: false })];
  assert.equal(call(worker, { executionEvents: afterResult }, false)!.speech, friendlyToolSpeech("WebSearch", input));

  // 換下一個工具 → 泡泡跟著換
  const bash = [...afterResult, ev("tool_call_start", { id: "t2", name: "Bash", input: { command: "npm test" } })];
  const atTerminal = call(worker, { executionEvents: bash }, false)!;
  assert.equal(atTerminal.station, "terminal");
  assert.equal(atTerminal.speech, friendlyToolSpeech("Bash", { command: "npm test" }));
});

test("mission NPC that starts talking after a tool shows his latest mission words", () => {
  const events = [
    ev("user_message"),
    ev("tool_call_start", { id: "t1", name: "Read", input: { file_path: "a.md" } }),
    ev("tool_call_result", { id: "t1" }),
    ev("text_delta", { text: "讀完了，重點是門檻高度" }),
  ];
  const shown = call(worker, { executionEvents: events }, false)!;
  assert.equal(shown.speech, "讀完了，重點是門檻高度");
});

test("busy mission NPC with no tool yet / between rounds still never shows stale own chat", () => {
  // 本輪剛開始、還沒工具也還沒說話
  const fresh = call(worker, { executionEvents: [ev("user_message")] }, false)!;
  assert.notEqual(fresh.speech, STALE);
  assert.equal(fresh.station, "home");
  // 上一輪說過話、本輪結束 → 顯示他最後的 Mission 發言
  const ended = call(worker, { executionEvents: [ev("user_message"), ev("text_delta", { text: "完成第一步" }), ev("turn_end")] }, false)!;
  assert.equal(ended.speech, "完成第一步");
  // Mission 裡完全還沒有他的事件
  const none = call(worker, { executionEvents: [ev("text_delta", { text: "別人在講" }, "w2")] }, false)!;
  assert.notEqual(none.speech, STALE);
  assert.notEqual(none.speech, "別人在講");
});

test("non-mission NPCs keep their own character (existing behaviour)", () => {
  // 沒有 Mission、閒置 → 不介入
  assert.equal(call(worker, null, false), null);
  assert.equal(call({ ...worker, busy: false }, { executionEvents: [ev("tool_call_start", { name: "Bash" })] }, false), null);
  // 沒有 Mission、但自己的對話正在跑工具、角色還停 home → 只覆寫站位，speech 照舊（自己串流已是當下的）
  const own = {
    ...worker,
    character: { ...character, speech: "執行指令：ls" },
    turns: [{ items: [{ kind: "tool_call", status: "running", name: "Bash", input: { command: "ls" } }] }],
  };
  const shown = call(own, undefined, false)!;
  assert.equal(shown.station, "terminal");
  assert.equal(shown.speech, "執行指令：ls");
});
