// Stage 3 跨重啟自裝狀態機測試：marker 正規化/存取、開機解析(健康→確認、不健康→回滾)。
// 這是「裝會殺掉自己進程」仍能安全自裝的命根——重啟後一定要正確判定成功或回滾。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizePendingSelfInstall,
  evaluateBootResolution,
  PendingSelfInstallStore,
  type PendingSelfInstall,
} from "../src/selfEvolvePending.js";
import type { PostInstallChecks } from "../src/selfEvolveInstall.js";

const marker: PendingSelfInstall = {
  firedAt: 1, reason: "r", changedFiles: ["server/src/foo.ts"],
  stagedExe: "C:/x/coldinstall/Pixel Crew.exe", rollbackExe: "C:/x/coldinstall/Pixel Crew.rollback.exe",
  prevExeMtimeMs: 1000,
};
const checks = (o: Partial<PostInstallChecks> = {}): PostInstallChecks => ({
  exeFresh: true, swappedOk: true, distHasNewCode: true, apiOk: true, healthOk: true, ...o,
});

test("normalize：缺 stagedExe/rollbackExe → null（無意義 marker 丟棄）", () => {
  assert.equal(normalizePendingSelfInstall(null), null);
  assert.equal(normalizePendingSelfInstall({ stagedExe: "x" }), null);
  assert.equal(normalizePendingSelfInstall({ rollbackExe: "x" }), null);
  const ok = normalizePendingSelfInstall({ stagedExe: "a", rollbackExe: "b" });
  assert.ok(ok && ok.stagedExe === "a" && ok.rollbackExe === "b");
});

test("開機解析：無 marker → none（不動作）", () => {
  assert.deepEqual(evaluateBootResolution(null, checks()), { action: "none" });
});

test("開機解析：有 marker＋四件套全過 → confirm_ok", () => {
  const r = evaluateBootResolution(marker, checks());
  assert.equal(r.action, "confirm_ok");
});

test("開機解析：有 marker＋任一不過 → rollback，且列出失敗項", () => {
  const r = evaluateBootResolution(marker, checks({ apiOk: false }));
  assert.equal(r.action, "rollback");
  assert.equal(r.action === "rollback" && r.result.failed.includes("api-200"), true);
});

test("開機解析：swap 沒發生(exe 沒換新) → rollback", () => {
  const r = evaluateBootResolution(marker, checks({ exeFresh: false, swappedOk: false }));
  assert.equal(r.action, "rollback");
});

test("Store：write→read→clear round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-"));
  try {
    const store = new PendingSelfInstallStore(dir);
    assert.equal(store.read(), null);
    store.write(marker);
    const back = store.read();
    assert.ok(back && back.stagedExe === marker.stagedExe && back.prevExeMtimeMs === 1000);
    store.clear();
    assert.equal(store.read(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
