import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { LocalStore } from "../src/store.js";
import { workspaceIdentity } from "../src/platform/paths.js";
import type { DepartmentMission } from "../src/mission.js";

// 回歸守衛：部門任務日誌／交辦清單整片空白的真兇——以工作區為 key 的資料表，寫入端存
// 真實大小寫、查詢端存正規化（win32 小寫）路徑，exact-match 就永遠撈不到（Windows 上光
// 磁碟機代號 C: 對 c: 就不同，等於每個工作區都空）。修法：store 的寫入與查詢都走同一個
// 正規化，呼叫端傳哪一種形式都撈得到。
//
// 這裡刻意用「尾端多一個分隔符」的原始路徑，因為它在每個平台上正規化後都跟原字串不同，
// 所以這支測試在 macOS/Linux 上也有辨識力——不會像只比大小寫那樣在非 Windows 被跳過。
function makeMission(overrides: Partial<DepartmentMission>): DepartmentMission {
  return {
    id: "m1", workspacePath: "/repo", bossWorkerId: "boss", objective: "Ship", acceptanceCriteria: ["tests"],
    status: "completed", planSummary: null, steps: [], currentStepIndex: null, correctionCount: 0, maxCorrections: 2,
    executionMode: "research", origin: "department",
    error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: "2026-07-22T00:00:00Z", completedAt: "2026-07-22T01:00:00Z",
    delegatedSessions: [], executionEvents: [],
    ...overrides,
  };
}

function withStore(run: (store: LocalStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-mission-casing-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    store.saveWorker({
      id: "boss", name: "Boss", model: null, colorIndex: 0, avatarId: null, avatarKind: "preset", avatarPresetId: "classic",
      provider: "claude", workspacePath: "/repo", sessionId: "s", completedTurns: 0, persona: null, autoApproveMode: "off",
    });
    run(store);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("a mission saved with a raw workspace path is found by either the raw or the normalized form", () => {
  withStore((store) => {
    const raw = `${join(sep, "Repo", "Sub")}${sep}`;
    const key = workspaceIdentity(raw);
    // 前提：這兩種形式在這個平台上真的不同，否則下面的斷言沒有辨識力。
    assert.notEqual(key, raw);

    // 走 production 寫入路徑，餵原始路徑（就是 boss.runner.workspacePath 的樣子）。
    assert.equal(store.saveDepartmentMission(makeMission({ id: "m1", workspacePath: raw })), true);
    assert.equal(store.saveDepartmentMission(makeMission({ id: "m2", workspacePath: raw })), true);

    // 路由查詢用正規化路徑（registryKey）——這是修好前會撈到 0 筆的那條。
    assert.equal(store.listDepartmentMissions(key).length, 2);
    // 原始路徑也要查得到：store 兩端都正規化，呼叫端不必記得先轉。
    assert.equal(store.listDepartmentMissions(raw).length, 2);
    // 不帶條件的列舉（snapshot 用）不受影響。
    assert.equal(store.listDepartmentMissions().length, 2);
  });
});

test("boss tasks and provider checkpoints share the same normalization", () => {
  withStore((store) => {
    const raw = `${join(sep, "Repo", "Sub")}${sep}`;
    const key = workspaceIdentity(raw);
    store.saveProviderCheckpoint("boss", "claude", raw, "sonnet", { sessionId: "s1", completedTurns: 3 });
    // 存原始、用正規化查（resolveDecisionRuntime 走這條），以及反過來，都要撈得到。
    assert.equal(store.loadProviderCheckpoint("boss", "claude", key)?.sessionId, "s1");
    assert.equal(store.loadProviderCheckpoint("boss", "claude", raw)?.completedTurns, 3);
  });
});

test("win32 treats a workspace that differs only in case as one key", () => {
  // Windows 的路徑不分大小寫，所以同一個工作區的不同寫法必須是同一個 key。
  assert.equal(
    workspaceIdentity("C:\\Users\\A\\Repo", "win32"),
    workspaceIdentity("c:\\users\\a\\repo", "win32"),
  );
});
