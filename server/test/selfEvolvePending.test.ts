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
  parseTimestampedLog,
  PendingSelfInstallStore,
  readSelfInstallVerdict,
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

// ── 開機驗收要等 pc-selfinstall 對「這一次」安裝的結論 ─────────────────────────

test("parseTimestampedLog 讀得懂 PowerShell 的 Get-Date -Format o（帶時區），沒時間戳的行略過", () => {
  const lines = parseTimestampedLog("2026-10-07T10:40:36.1234567+08:00 hello\nnpm noise\n2026-10-07T02:40:37.0000000Z bye\n");
  assert.deepEqual(lines.map((l) => l.message), ["hello", "bye"]);
  assert.equal(lines[0].at, Date.parse("2026-10-07T02:40:36.123Z"));
});

const FIRED = Date.parse("2026-10-07T02:00:00Z");
const pending: PendingSelfInstall = { ...marker, firedAt: FIRED, stagedSha256: "abc123" };
const at = (minutes: number) => new Date(FIRED + minutes * 60_000).toISOString().replace("Z", "0000+00:00");
const oldInstall = [
  `${at(-90)} === self-install start ===`,
  `${at(-90)} staged hash: OLDHASH`,
  `${at(-89)} installed hash matches staged -- SWAPPED OK`,
  `${at(-89)} health 200 -- HEALTHY OK`,
  `${at(-89)} === self-install OK (new version healthy; app boot-resolver will promote rollback point) ===`,
].join("\n");

test("之前安裝留下的 SWAPPED OK／self-install OK 不算這次的（還在等 → pending）", () => {
  assert.deepEqual(readSelfInstallVerdict(oldInstall, pending), { state: "pending", swapped: false });
  const started = `${oldInstall}\n${at(1)} === self-install start ===\n${at(1)} staged hash: ABC123\n`;
  assert.deepEqual(readSelfInstallVerdict(started, pending), { state: "pending", swapped: false }, "換入／健康輪詢還沒跑完");
});

test("這次安裝（firedAt 之後、hash 相符）健康 → healthy", () => {
  const log = `${oldInstall}\n${at(1)} === self-install start ===\n${at(1)} staged hash: ABC123\n${at(2)} installed hash matches staged -- SWAPPED OK\n${at(2)} health 200 -- HEALTHY OK\n${at(2)} === self-install OK (new version healthy; app boot-resolver will promote rollback point) ===\n`;
  assert.deepEqual(readSelfInstallVerdict(log, pending), { state: "healthy", swapped: true });
});

test("判不健康後回滾路徑也會印 HEALTHY OK（舊版起來了）——仍是 failed，不能晉升", () => {
  const log = [
    `${at(1)} === self-install start ===`, `${at(1)} staged hash: ABC123`,
    `${at(2)} installed hash matches staged -- SWAPPED OK`,
    `${at(3)} WARNING: health check did not reach 200 within 60s`,
    `${at(3)} UNHEALTHY -> rolling back to previous good version`,
    `${at(4)} installed hash matches staged -- SWAPPED OK`, `${at(4)} health 200 -- HEALTHY OK`,
    `${at(4)} === rolled back to previous good version; healthy ===`,
  ].join("\n");
  assert.equal(readSelfInstallVerdict(log, pending).state, "failed");
  assert.equal(readSelfInstallVerdict(`${at(1)} === self-install start ===\n${at(1)} FATAL: staged missing: x`, { ...pending, stagedSha256: undefined }).state, "failed");
});

test("staged hash 對不上（裝的不是這一版）不算數", () => {
  const log = `${at(1)} === self-install start ===\n${at(1)} staged hash: SOMETHINGELSE\n${at(2)} installed hash matches staged -- SWAPPED OK\n${at(2)} === self-install OK (x) ===\n`;
  assert.equal(readSelfInstallVerdict(log, pending).state, "pending");
});

test("開機解析：沒等到 pc-selfinstall 的健康結論 → 不晉升", () => {
  const r = evaluateBootResolution(pending, checks({ healthOk: false }));
  assert.equal(r.action, "rollback");
});

test("pc-selfrebuild 寫 marker 用正確的 epoch ms，firedAt 是交棒時間而不是舊 exe 的 mtime", () => {
  const script = fs.readFileSync(new URL("../../scripts/windows/pc-selfrebuild.ps1", import.meta.url), "utf8");
  // (Get-Date '1970-01-01Z') 是本地時間：在 UTC+8 會差 8 小時，讓 exeFresh 永遠成立。
  const code = script.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /Get-Date '1970/);
  assert.match(script, /\$prevMtime = \(\[DateTimeOffset\]\(\(Get-Item -LiteralPath \$installedExe\)\.LastWriteTimeUtc\)\)\.ToUnixTimeMilliseconds\(\)/);
  assert.match(script, /\$firedAt = \[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\)/);
  assert.match(script, /firedAt = \$firedAt;/);
  // Windows PowerShell 5.1 會把無 BOM 的 UTF-8 中文讀壞：腳本維持純 ASCII。
  assert.doesNotMatch(script, /[^\x00-\x7f]/);
});
