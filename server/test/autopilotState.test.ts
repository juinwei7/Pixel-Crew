import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT_MAX_STEPS } from "../src/autopilot.js";
import { AutopilotStateStore, normalizeAutopilotStates } from "../src/autopilotState.js";

test("normalize keeps valid entries, clamps steps, and nulls bad deadlines", () => {
  const restored = normalizeAutopilotStates({
    "c:/users/a/desktop/測試": { stepsRemaining: 5, deadlineAt: null, autoResolve: true },
    "d:/米線": { stepsRemaining: 999, deadlineAt: "soon", autoResolve: "yes" },
  });
  assert.deepEqual(restored["c:/users/a/desktop/測試"], { stepsRemaining: 5, deadlineAt: null, autoResolve: true });
  // 超界步數夾回上限；非數字 deadline 變 null；autoResolve 非 true 一律 false。
  assert.deepEqual(restored["d:/米線"], { stepsRemaining: AUTOPILOT_MAX_STEPS, deadlineAt: null, autoResolve: false });
});

test("normalize drops garbage wholesale instead of resurrecting broken guardrails", () => {
  assert.deepEqual(normalizeAutopilotStates(null), {});
  assert.deepEqual(normalizeAutopilotStates([1, 2]), {});
  assert.deepEqual(normalizeAutopilotStates("x"), {});
  // 步數 0／負數／缺欄位的條目整條丟棄——不能還原出一個永不停止的循環。
  const restored = normalizeAutopilotStates({
    a: { stepsRemaining: 0, deadlineAt: null, autoResolve: false },
    b: { deadlineAt: null },
    c: ["not", "an", "object"],
  });
  assert.deepEqual(restored, {});
});

test("store round-trips through the JSON file and survives a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-autopilot-state-"));
  const store = new AutopilotStateStore(dir);
  assert.deepEqual(store.load(), {}); // 檔案不存在 → 全關
  const states = { "c:/repo": { stepsRemaining: 3, deadlineAt: null, autoResolve: true } };
  store.save(states);
  assert.deepEqual(store.load(), states);
  assert.match(readFileSync(join(dir, "autopilot-state.json"), "utf8"), /"stepsRemaining": 3/);
  writeFileSync(join(dir, "autopilot-state.json"), "{corrupt", "utf8");
  assert.deepEqual(store.load(), {}); // 壞檔 → 當成全關，跟舊行為一致
});
