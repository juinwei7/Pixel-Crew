import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStore } from "../src/store.js";
import type { DepartmentMission } from "../src/mission.js";

test("persists Department Missions, fails active work on restart, and keeps needs-attention recoverable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-mission-store-"));
  const path = join(dir, "test.sqlite");
  let store: LocalStore | null = null;
  try {
    store = new LocalStore(path);
    store.saveWorker({
      id: "boss", name: "Boss", model: null, colorIndex: 0, avatarId: null, avatarKind: "preset", avatarPresetId: "classic",
      provider: "claude", workspacePath: "/repo", sessionId: "session-boss", completedTurns: 0, persona: null, autoApproveMode: "off",
    });
    const base: DepartmentMission = {
      id: "active", workspacePath: "/repo", bossWorkerId: "boss", objective: "Ship", acceptanceCriteria: ["tests"],
      status: "planning", planSummary: null, steps: [], currentStepIndex: null, correctionCount: 0, maxCorrections: 2,
      executionMode: "research",
      origin: "boss",
      error: null, createdAt: "2026-07-22T00:00:00Z", startedAt: "2026-07-22T00:00:00Z", completedAt: null,
      delegatedSessions: [{ workerId: "boss", provider: "claude", model: "sonnet", sessionId: "mission-session", completedTurns: 1 }],
      executionEvents: [{ workerId: "boss", stepId: null, event: { type: "tool_call_start", id: "tool-1", name: "mcp__issues__list", input: {} } }],
    };
    assert.equal(store.saveDepartmentMission(base), true);
    assert.equal(store.saveDepartmentMission({ ...base, id: "attention", status: "needs_attention" }), true);
    assert.equal(store.listDepartmentMissions("/repo").length, 2);
    store.close();
    store = new LocalStore(path);
    assert.equal(store.getDepartmentMission("active")?.status, "failed");
    assert.match(store.getDepartmentMission("active")?.error ?? "", /伺服器重啟/);
    assert.equal(store.getDepartmentMission("active")?.delegatedSessions?.[0]?.sessionId, "mission-session");
    assert.equal(store.getDepartmentMission("active")?.executionEvents?.[0]?.event.type, "tool_call_start");
    assert.equal(store.getDepartmentMission("active")?.executionMode, "research");
    assert.equal(store.getDepartmentMission("active")?.origin, "boss");
    assert.equal(store.markDepartmentMissionsOrigin(["attention"], "boss"), true);
    assert.equal(store.getDepartmentMission("attention")?.origin, "boss");
    assert.equal(store.getDepartmentMission("attention")?.status, "needs_attention");
    assert.deepEqual(store.listReservedDepartmentMissions().map((mission) => mission.id), ["attention"]);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
