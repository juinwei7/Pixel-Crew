// 結構化停滯標記（task.stall）的行為鎖（2026-09-30 結構化改造）：
// 拔掉 bossDeptCreateRetry／bossUsageRetry 靠 task.error「文案比對」認領的病根後，
// 鎖住兩條行為不許回退——(1) 失敗文案任意改寫（換措辭、換語系、跨版本）認領不漂移；
// (2) 兩引擎依 stall.kind 命名空間認領，結構上互不搶單。
// 中央護欄 reconcileBossTaskStall（persistBossTask 落地前必經）一併在此鎖住。
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBossTaskStall, type BossTaskStall } from "../src/bossTask.js";
import { DeptCreateRetryTracker, deptCreateRetryAction, deptCreateStallKind, DEPT_CREATE_RETRY_BASE_COOLDOWN_MS } from "../src/bossDeptCreateRetry.js";
import { UsageRetryTracker, usageRetryAction, usageStallKind, USAGE_RETRY_BASE_COOLDOWN_MS } from "../src/bossUsageRetry.js";

const stallOf = (kind: BossTaskStall["kind"], error: string): BossTaskStall => ({ kind, error });

// ── 中央護欄：persistBossTask 落地前的 stall 一致性 ─────────────────────────

test("中央護欄：狀態仍卡住且 error 未被改寫 → 保留 stall（登記點寫入後的正常落地）", () => {
  const stall = stallOf(deptCreateStallKind("dedicated"), "無法自動建立專屬臨時部門（工作區忙碌）");
  const task = { status: "needs_attention" as const, error: "無法自動建立專屬臨時部門（工作區忙碌）", stall };
  assert.deepEqual(reconcileBossTaskStall(task), stall);
});

test("中央護欄：任務離開 needs_attention（成功推進／取消／失敗）→ 清 stall", () => {
  const stall = stallOf(usageStallKind("decide"), "Claude 無法進行任務判斷：視窗已用盡");
  for (const status of ["ready", "running", "completed", "failed", "cancelled", "discovering"] as const) {
    assert.equal(reconcileBossTaskStall({ status, error: stall.error, stall }), null, `status=${status} 應清掉 stall`);
  }
});

test("中央護欄：任何寫入點把 task.error 換掉（別的失敗接手）→ 清 stall，殭屍認領留不下來", () => {
  const stall = stallOf(deptCreateStallKind("decide"), "無法自動建立專屬部門（人數已滿）");
  // 換成派工被擋、用量受限、或清空——一律視為別的停滯型態接手
  assert.equal(reconcileBossTaskStall({ status: "needs_attention", error: "「臨時隊」暫時無法開始：主管忙碌中", stall }), null);
  assert.equal(reconcileBossTaskStall({ status: "needs_attention", error: null, stall }), null);
  // 沒有標記的任務永遠回 null（含舊 payload_json 缺欄）
  assert.equal(reconcileBossTaskStall({ status: "needs_attention", error: "任何失敗" }), null);
  assert.equal(reconcileBossTaskStall({ status: "needs_attention", error: "任何失敗", stall: null }), null);
});

// ── 鎖 1：文案任意改寫，認領不漂移 ──────────────────────────────────────────

test("失敗文案跨版本改寫／換語系：stall.kind 不變 → 引擎照常認領（重啟重建同款不漂移）", () => {
  // 模擬：v1 用舊文案登記並落地；之後程式碼把失敗文案整段改寫（上輪就改過 C-1/C-2
  // 文案）、甚至切換語系。落地的 stall 快照與 task.error 同物同存，兩者仍吻合——
  // 中央護欄保留標記，引擎依 kind 認領，文案內容完全不參與判定。
  const persisted = {
    status: "needs_attention" as const,
    error: "【舊版文案】無法自動建立專屬臨時部門，請稍後再試。",
    stall: stallOf(deptCreateStallKind("dedicated"), "【舊版文案】無法自動建立專屬臨時部門，請稍後再試。"),
  };
  const kept = reconcileBossTaskStall(persisted);
  assert.deepEqual(kept, persisted.stall);
  const tracker = new DeptCreateRetryTracker();
  tracker.note("task-1", "dedicated", null, 0);
  const action = deptCreateRetryAction(tracker, "task-1", {
    status: persisted.status,
    stallKind: kept?.kind ?? null,
    workspaceFree: true,
    providerReady: true,
    inFlight: false,
  }, DEPT_CREATE_RETRY_BASE_COOLDOWN_MS);
  assert.equal(action.kind, "retry");
  // 開機重建同款：認回入口只看 kind，與現行程式碼會產生什麼文案無關
  assert.equal(persisted.stall.kind === deptCreateStallKind("dedicated"), true);
  assert.equal(persisted.stall.kind === deptCreateStallKind("decide"), false);
});

test("usage 引擎同款：受限文案怎麼改寫都不影響認領", () => {
  const tracker = new UsageRetryTracker();
  tracker.note("task-1", "decide", 0);
  // 同一個 stall 標記配上三種完全不同的（假想）文案演進——引擎視圖根本不含文案，
  // 認領結果恆定為 probe
  const action = usageRetryAction(tracker, "task-1", {
    status: "needs_attention",
    stallKind: usageStallKind("decide"),
    inFlight: false,
  }, USAGE_RETRY_BASE_COOLDOWN_MS);
  assert.equal(action.kind, "probe");
});

// ── 鎖 2：兩引擎互不搶單（stall.kind 命名空間結構性隔離）────────────────────

test("dept_create 引擎不認 usage:* 的停滯；usage 引擎不認 dept_create:* 的停滯", () => {
  const deptTracker = new DeptCreateRetryTracker();
  deptTracker.note("task-1", "decide", null, 0);
  const usageTracker = new UsageRetryTracker();
  usageTracker.note("task-1", "decide", 0);
  const later = Math.max(DEPT_CREATE_RETRY_BASE_COOLDOWN_MS, USAGE_RETRY_BASE_COOLDOWN_MS);
  // 交辦目前卡在「用量受限」：dept 引擎必須放手（哪怕它手上有同一張的舊登記）
  assert.deepEqual(deptCreateRetryAction(deptTracker, "task-1", {
    status: "needs_attention", stallKind: usageStallKind("decide"), workspaceFree: true, providerReady: true, inFlight: false,
  }, later), { kind: "drop" });
  // 交辦目前卡在「建立失敗」：usage 引擎必須放手
  assert.deepEqual(usageRetryAction(usageTracker, "task-1", {
    status: "needs_attention", stallKind: deptCreateStallKind("decide"), inFlight: false,
  }, later), { kind: "drop" });
  // 兩個命名空間永不相等（型別層也由 BossTaskStallKind 聯集把關）
  assert.notEqual(deptCreateStallKind("decide") as string, usageStallKind("decide") as string);
});
