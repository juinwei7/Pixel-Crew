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
  const disarm = route.indexOf("stopWorkerAutopilotForInterrupt(worker)");
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
