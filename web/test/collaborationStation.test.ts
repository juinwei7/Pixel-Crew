import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { missionCharacter } from "../src/game/missionScene.js";
import { applyRunnerEvent, emptyWorker } from "../src/workerState.js";

// 守門：協作（CollaborationTask running/returning）不像 Mission 走獨立 runner——
// 目標 NPC 用 target.runner.send、來源 NPC 接續用 source.runner.send，兩者都是 createRunner
// 建的 worker 自己的 session，事件走 record(worker) → worker 事件串流 → applyRunnerEvent 設站位。
// 所以協作中的 NPC 本來就會走去工作站，不需要 Mission 那種 executionEvents 推導。
// 若有人把協作改成獨立 runner（事件不再進 worker 串流），這裡會紅，提醒要補 missionCharacter 那類推導。

const serverIndex = readFileSync(fileURLToPath(new URL("../../server/src/index.ts", import.meta.url)), "utf8");

test("collaboration turns run on the workers' own runners (events reach the worker stream)", () => {
  // createRunner 的事件回呼＝record(worker)（worker 自己的串流）
  const createRunner = serverIndex.slice(serverIndex.indexOf("function createRunner("), serverIndex.indexOf("function workerCleanDeps("));
  assert.match(createRunner, /new CodexSession\(\s*\(event\) => record\(worker, event\)/);
  assert.match(createRunner, /new ClaudeSession\(\s*\(event\) => record\(worker, event\)/);
  // 協作派工：目標 NPC 用自己的 runner
  assert.match(serverIndex, /target\.runner\.send\(prompt, \[\], \[\], \{ executionProfile: "read_only_collaboration" \}\)/);
  // 協作交回（returning）：來源 NPC 用自己的 runner 接續
  const finish = serverIndex.slice(serverIndex.indexOf("function finishCollaboration("), serverIndex.indexOf("function missionMembers("));
  assert.match(finish, /task\.status = "returning";[\s\S]*source\.runner\.send\(message\)/);
  // 只有三種 session 建構點：worker 自己的（createRunner）、Mission 獨立 runner、一次性 detached（不屬於任何 NPC 身上的回合）
  assert.equal((serverIndex.match(/new ClaudeSession\(/g) ?? []).length, 3, "new separate runner path? check whether its tool events reach the worker stream");
});

test("collaboration NPC walks to the tool station straight from his own event stream", () => {
  let w = emptyWorker("target", "小幫手", null, true, 0, "claude", "C:/ws");
  w = applyRunnerEvent(w, { type: "user_message", text: "NPC 協作 · Review：看一下" });
  w = applyRunnerEvent(w, { type: "tool_call_start", id: "t1", name: "Read", input: { file_path: "a.ts" } });
  assert.equal(w.character.station, "books");
  // 沒有 Mission → missionCharacter 不介入（站位與 speech 都沿用自己的串流）
  assert.equal(missionCharacter(w, undefined, false), null);
});
