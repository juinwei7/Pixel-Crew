import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStore } from "../src/store.js";
import { workspaceIdentity } from "../src/platform/paths.js";
import type { DepartmentMission } from "../src/mission.js";

// 回歸守衛：部門任務日誌重整後空白的真兇——mission 的 workspace_path 存的是 workspaceIdentity
// 正規化後（win32 小寫）的路徑，但部門保留使用者原始大小寫。路由若直接拿原始路徑做 SQL
// exact-match 就會撈到 0 筆。修法：查詢端一律先 registryKey/workspaceIdentity 正規化。
// 這支測試釘死「正規化查得到、未正規化會漏」這個不變式（路由現在照此傳入正規化路徑）。
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

test("missions stored under a normalized path are found via a normalized query, and missed via a raw one", () => {
  withStore((store) => {
    const raw = "C:\\Users\\victo\\Desktop\\量化交易";
    const normalized = workspaceIdentity(raw); // = registryKey(raw); the form missions actually land under
    store.saveDepartmentMission(makeMission({ id: "m1", workspacePath: normalized }));
    store.saveDepartmentMission(makeMission({ id: "m2", workspacePath: normalized }));

    // What the fixed routes do: normalize the query path first → both entries come back.
    assert.equal(store.listDepartmentMissions(normalized).length, 2);

    // The bug this guards against: querying with the un-normalized (different-cased) path
    // exact-matches nothing → blank task log. Only assert where normalization actually differs.
    if (raw !== normalized) {
      assert.equal(store.listDepartmentMissions(raw).length, 0);
    }

    // No-arg listing (used by the snapshot) is unaffected and still returns everything.
    assert.equal(store.listDepartmentMissions().length, 2);
  });
});
