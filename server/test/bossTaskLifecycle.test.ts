import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 交辦生命週期的接線檢查：這些路由與編排都在 index.ts 裡，沒有不開整台伺服器就能跑的入口，
   所以比照 ephemeralWorkers.test.ts 直接讀原始碼，鎖住「收尾時一定要做的事」不被改掉。 */

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到 ${startMarker}`);
  const end = indexSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `找不到 ${endMarker}`);
  return indexSource.slice(start, end);
}

test("deleting a boss task cancels its live or paused missions like /cancel does", () => {
  // needs_attention 的交辦可刪除，但底下暫停的 Mission 仍佔工作區＋部門鎖、重啟後還原，
  // 刪掉交辦就再也沒有入口能取消它。
  const route = block('app.delete("/api/boss-tasks/:id"', "app.post(\"/api/boss-tasks/:id/restart\"");
  const cancel = route.indexOf("cancelMissionForScopedRestart(mission)");
  assert.notEqual(cancel, -1);
  assert.match(route, /bossTaskRestartScope\(task\)\.activeMissions/);
  // 先收 Mission，再解散臨時團隊、刪列（與 /cancel 同順序）。
  assert.ok(cancel < route.indexOf("disbandTaskEphemeralDepartments(task)"));
  assert.ok(cancel < route.indexOf("store.deleteBossTask(task.id)"));
});

test("disbanding a temporary crew cancels the missions still running on it", () => {
  // 以前只停掉、移除成員：跑在這支隊上的 Mission 留在 activeMissions 裡收不到任何事件，
  // 工作區鎖一路卡到重啟（重啟後還會被 listReservedDepartmentMissions 還原）。
  const disband = block("function disbandEphemeralDepartment(", "function disbandTaskEphemeralDepartments(");
  const cancel = disband.indexOf("cancelMissionForScopedRestart(mission)");
  assert.notEqual(cancel, -1);
  assert.ok(cancel < disband.indexOf("workers.delete(workerId)"), "要在移除成員前收掉 Mission");
  assert.match(disband, /advanceBossTasksForMission\(mission\.id\)/);
});

test("autopilot disbands the finished task's crew before spawning the next task", () => {
  const advance = block("async function advanceAutopilot(", "app.get(\"/api/autopilot\"");
  const disband = advance.indexOf("disbandTaskEphemeralDepartments(justFinished)");
  const spawn = advance.indexOf("await spawnBossTask(");
  assert.notEqual(disband, -1);
  assert.notEqual(spawn, -1);
  assert.ok(disband < spawn, "先解散上一張的臨時團隊，下一張才不會被派進一支馬上要解散的隊");
});

test("boss routing only offers the deciding task's own temporary crew", () => {
  const candidates = block("function bossTaskCandidates(", "function persistBossTask(");
  assert.match(candidates, /routableDepartment\(department\.id, ephemeralDepartments, ownCrewIds\)/);
  // 為交辦剛開的隊要交回同一張的第二輪決策。
  assert.match(indexSource, /await decideBossTask\(task, false, \[department\.id\]\)/);
});

test("the decide create_department branch re-reads the task after building the crew", () => {
  const decide = block("async function decideBossTaskInner(", "function missionReport(");
  const create = decide.indexOf("await createDepartmentForObjective(");
  const recheck = decide.indexOf("snapshotStillCurrent(task.status, store.getBossTask(task.id))", create);
  assert.ok(create !== -1 && recheck !== -1, "建部門後要重讀交辦");
  assert.ok(recheck < decide.indexOf("await decideBossTask(task, false"), "要在第二輪決策（派工）前重讀");
  assert.match(decide, /newCrewOrphaned\(store\.getBossTask\(task\.id\), department\.id\)/);
});

test("autopilot stand-in answers and auto-resolve write to the re-read task, not the hook-time snapshot", () => {
  const answer = block("async function autoAnswerBossTask(", "async function autoResolveBossTask(");
  assert.match(answer, /pendingQuestionUnchanged\(task, live\)/);
  assert.match(answer, /persistBossTask\(live\)/);
  assert.doesNotMatch(answer, /persistBossTask\(task\)/);
  const resolve = block("async function autoResolveBossTask(", "async function advanceAutopilot(");
  assert.match(resolve, /snapshotStillCurrent\(task\.status, live\)/);
  assert.match(resolve, /advanceBossTaskStages\(live\)/);
  assert.doesNotMatch(resolve, /advanceBossTaskStages\(task\)/);
  const disable = block("function disableAutopilotWithNote(", "async function spawnBossTask(");
  assert.match(disable, /store\.getBossTask\(task\.id\)/);
  assert.doesNotMatch(disable, /persistBossTask\(task\)/);
});

test("a malformed next-step reply is retried once and never labelled a normal finish", () => {
  const advance = block("async function advanceAutopilot(", "app.get(\"/api/autopilot\"");
  assert.match(advance, /decideWithFormatRepair\(/);
  // 正常結束只留給模型明確選 stop；格式失敗走失敗文案。
  assert.doesNotMatch(advance, /!decision \|\| decision\.action === "stop"/);
  assert.match(advance, /autopilotFormatFailureNote\(parsed\.failure\)/);
  for (const name of ["autoAnswerBossTask", "autoResolveBossTask"]) {
    const body = block(`async function ${name}(`, name === "autoAnswerBossTask" ? "async function autoResolveBossTask(" : "async function advanceAutopilot(");
    assert.match(body, /decideWithFormatRepair\(/, `${name} 要有格式修復重問`);
  }
});
