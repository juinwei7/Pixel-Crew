import assert from "node:assert/strict";
import test from "node:test";
import { legacyDepartmentName, normalizeDepartmentName } from "../src/department.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore, type PersistedWorker } from "../src/store.js";

test("department names are normalized and bounded", () => {
  assert.equal(normalizeDepartmentName("  後台   開發部  "), "後台 開發部");
  assert.equal(normalizeDepartmentName("x".repeat(100)).length, 80);
});

test("legacy department names use only the workspace folder without duplicating the suffix", () => {
  assert.equal(legacyDepartmentName("/Users/weiwei/company/boss"), "boss部門");
  assert.equal(legacyDepartmentName("C:\\company\\金融部門\\"), "金融部門");
});

function worker(id: string, departmentId: string): Omit<PersistedWorker, "events"> {
  return {
    id, name: id, model: null, colorIndex: 0, avatarId: null, avatarKind: "preset",
    avatarPresetId: "classic", provider: "claude", workspacePath: "/repo",
    sessionId: `session-${id}`, completedTurns: 0, persona: { role: "Engineer", instructions: "Build safely" },
    autoApproveMode: "off", departmentId,
  };
}

test("persists a department and all members atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-department-"));
  const store = new LocalStore(join(directory, "data.sqlite"));
  try {
    const now = new Date().toISOString();
    const department = { id: "dept", name: "平台部", purpose: "Build", workspacePath: "/repo", leadWorkerId: "lead", memberWorkerIds: ["lead", "reviewer"], createdAt: now, updatedAt: now };
    assert.equal(store.saveDepartmentWithWorkers(department, [worker("lead", "dept"), worker("reviewer", "dept")]), true);
    assert.deepEqual(store.listDepartments()[0]?.memberWorkerIds, ["lead", "reviewer"]);

    const rejected = { ...department, id: "rejected", name: "不完整部門", leadWorkerId: "new" };
    assert.equal(store.saveDepartmentWithWorkers(rejected, [worker("new", "rejected"), worker("lead", "rejected")]), false);
    assert.equal(store.listDepartments().some((item) => item.id === "rejected"), false);
    assert.equal(store.loadWorkers(10).some((item) => item.id === "new"), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
