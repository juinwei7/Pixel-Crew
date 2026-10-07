// 接線回歸：個人自動循環在 index.ts 的幾個入口（停止、切換工作位置、無限制模式）有沒有真的撤掉循環。
// 路由寫在組裝層、無法單獨載入，這裡比照 ephemeralWorkers.test.ts 直接檢查原始碼。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

function block(startMarker: string): string {
  const start = indexSource.indexOf(startMarker);
  assert.ok(start >= 0, `index.ts 找不到 ${startMarker}`);
  const end = indexSource.indexOf("\n}", start);
  return indexSource.slice(start, end);
}

test("Stop disarms the personal autopilot before interrupting the runner", () => {
  const route = block('app.post("/api/workers/:id/interrupt"');
  const disarm = route.indexOf("disarmWorkerAutopilot(worker,");
  const interrupt = route.indexOf("worker.runner.interrupt()");
  assert.ok(disarm >= 0, "停止端點必須撤掉個人自動循環（Claude 的中止不經 turn_end，循環會自己再送下一步）");
  assert.ok(disarm < interrupt, "要在中止 runner 之前撤，Codex 的中止回合才不會被當成「上一回合出錯」");
});

test("the Stop note waits for the interrupted turn to close (turn_end or error)", () => {
  const hook = block("function workerAutopilotHook(");
  const flush = hook.indexOf("workerAutopilotStopNotes.get(worker.id)");
  const turnEndOnly = hook.indexOf('if (event.type !== "turn_end") return;');
  assert.ok(flush >= 0 && flush < turnEndOnly, "停止註記要在 error 事件也能貼出（Claude 的中止只發 error）");
});

test("unrestricted (invincible) mode is refused at enable time and disarms the loop on every later path", () => {
  const enable = block('app.post("/api/workers/:id/autopilot"');
  assert.ok(enable.indexOf("workerAutopilotForbidden(worker)") >= 0, "開循環時要拒絕⚡無限制模式");
  assert.ok(
    enable.indexOf("workerAutopilotForbidden(worker)") < enable.indexOf("setWorkerAutopilot("),
    "要在武裝之前拒絕，連「開了立即想第一步」都不能發生",
  );
  const modeRoute = block('app.post("/api/workers/:id/auto-approve"');
  assert.match(modeRoute, /if \(mode === "invincible"\) disarmWorkerAutopilot\(worker, workerAutopilotInvincibleNote\(\)\)/);
  const hook = block("function workerAutopilotHook(");
  assert.match(hook, /workerAutopilotForbidden\(worker\)/);
  const advance = indexSource.slice(indexSource.indexOf("async function advanceWorkerAutopilot("), indexSource.indexOf("function sweepWorkerAutopilot("));
  // 開頭擋一次、決策回來要送之前再擋一次（決策期間才切模式）。
  assert.equal(advance.match(/workerAutopilotForbidden\(worker\)/g)?.length, 2);
  const sweep = block("function sweepWorkerAutopilot(");
  assert.match(sweep, /unattendedForbidden: worker \? workerAutopilotForbidden\(worker\) : false/);
  assert.match(sweep, /action === "disable_unattended"/);
});

test("switching workspace disarms the loop, drops the old repo's plan, and voids in-flight decisions", () => {
  const route = block('app.patch("/api/workers/:id/workspace"');
  const reset = route.indexOf("reset: true");
  const disarm = route.indexOf("disarmWorkerAutopilot(worker,");
  assert.ok(disarm >= 0, "切換工作位置要撤掉個人自動循環");
  assert.ok(reset >= 0 && reset < disarm, "註記要在 reset 廣播之後貼，否則前端重建時會把它清掉");
  assert.match(route, /delete workerAutopilotPlans\[worker\.id\]/);
  const advance = indexSource.slice(indexSource.indexOf("async function advanceWorkerAutopilot("), indexSource.indexOf("function sweepWorkerAutopilot("));
  assert.match(advance, /worker\.runner\.workspacePath !== decisionWorkspace/);
  // 決策期間的每個檢查點都要看位置有沒有換，而不是只看循環還在不在（可能已被重新打開）。
  assert.doesNotMatch(advance, /if \(!workerAutopilotByWorker\.has\(worker\.id\) \|\| !workers\.has\(worker\.id\)\) return;/);
});
