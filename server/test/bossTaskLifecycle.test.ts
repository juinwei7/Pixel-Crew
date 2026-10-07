import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 交辦生命週期的接線檢查：這些路由與編排都在 index.ts 裡，沒有不開整台伺服器就能跑的入口，
   所以比照 ephemeralWorkers.test.ts 直接讀原始碼，鎖住「收尾時一定要做的事」不被改掉。 */

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n"); // Windows checkout 是 CRLF

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

test("a boss task that recovers re-arms the autopilot trigger at the central write point", () => {
  const persist = block("function persistBossTask(", "// 為一個交辦目標即時建立一支專屬部門");
  assert.match(persist, /if \(autopilotTriggerRearms\(task\.status\)\) autopilotFired\.delete\(task\.id\);/);
});

test("autopilot triggers yielded to the global lock are replayed when the lock is released", () => {
  const hook = block("function autopilotHook(", "// 自動循環的決策呼叫");
  // 三個讓出分支都要登記重播，不能只把觸發權還回去。
  assert.equal(hook.match(/autopilotDeferred\.defer\(task\.id\)/g)?.length, 3);
  // 背景推進一律接住意外丟錯（unhandledRejection 會讓整台伺服器退出）。
  assert.doesNotMatch(hook, /void (advanceAutopilot|autoAnswerBossTask|autoResolveBossTask)\([^)]*\);/);
  for (const [name, end] of [
    ["async function autoAnswerBossTask(", "async function autoResolveBossTask("],
    ["async function autoResolveBossTask(", "async function advanceAutopilot("],
    ["async function advanceAutopilot(", "app.get(\"/api/autopilot\""],
  ] as const) {
    const body = block(name, end);
    const finallyAt = body.lastIndexOf("} finally {");
    assert.notEqual(finallyAt, -1, name);
    assert.match(body.slice(finallyAt), /replayDeferredAutopilotTriggers\(\)/, `${name} 釋放鎖時要重播`);
  }
  // 代答後的重跑決策放在 finally 之外：不會在決策跑完後才清掉期間別人剛拿到的鎖。
  const answer = block("async function autoAnswerBossTask(", "async function autoResolveBossTask(");
  assert.ok(answer.indexOf("await decideBossTask(answered)") > answer.lastIndexOf("} finally {"));
});

test("a spawned task that fails is reported instead of leaving the loop silently on", () => {
  const advance = block("async function advanceAutopilot(", "app.get(\"/api/autopilot\"");
  const spawn = advance.indexOf("await spawnBossTask(");
  assert.ok(advance.lastIndexOf("try {", spawn) > advance.indexOf("disbandTaskEphemeralDepartments(justFinished)"), "spawn 要包在自己的 try/catch 裡");
  assert.match(advance, /無法建立下一個交辦（\{error\}）/);
  // 探索就失敗的交辦不會再經過 advanceBossTask：決策的失敗收尾要自己通知自動循環。
  const decide = block("async function decideBossTaskInner(", "function missionReport(");
  const catchAt = decide.lastIndexOf("} catch (error) {");
  assert.match(decide.slice(catchAt), /autopilotHook\(task\);/);
});

test("every crew built for a boss task takes its approval mode from the task, and guest requests mark the task", () => {
  const create = block("async function createDepartmentForObjective(", "\n}\n");
  assert.match(create, /worker\.autoApproveMode = input\.approveMode/);
  assert.doesNotMatch(create, /autoApproveMode = "full"/);
  const calls = indexSource.match(/createDepartmentForObjective\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(calls.length >= 3);
  for (const call of calls) assert.match(call, /approveMode: dedicatedCrewApproveMode\(task\)/);
  assert.match(block('app.post("/api/boss-tasks", async', "res.status(201)"), /isShareGuestAccess\(req\.headers\["x-pc-access"\]\) \? \{ requestedByShareGuest: true \}/);
  assert.match(block('app.post("/api/boss-tasks/:id/messages", async', "\n});\n"), /if \(isShareGuestAccess\(req\.headers\["x-pc-access"\]\)\) task\.requestedByShareGuest = true;/);
  assert.match(indexSource, /spawnBossTask\([^;]*justFinished\.requestedByShareGuest === true\)/);
});
