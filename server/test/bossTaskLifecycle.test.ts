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
