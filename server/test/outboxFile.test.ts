import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveOutboxFile } from "../src/outboxFile.js";

// 通道 F 回歸測試：/api/outbox/file 的守門判定（resolveOutboxFile）。
// 守的是「NPC 在 outbox/ 內放 symlink 指向 workspace 外機密檔，讀取端跟隨連結外洩」這條路。
// 若把 lstatSync 改回 statSync（跟隨連結）或拿掉 isSymbolicLink 判斷，symlink 案就會轉綠→這裡轉紅。

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-outbox-"));
  mkdirSync(join(dir, "outbox"));
  return dir;
}

test("serves a normal file inside outbox/", () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(join(ws, "outbox", "report.md"), "hello");
    const res = resolveOutboxFile(ws, "report.md");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.fullPath, join(ws, "outbox", "report.md"));
      assert.equal(res.size, 5);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rejects path traversal in the file name with 400", () => {
  const ws = makeWorkspace();
  try {
    assert.deepEqual(resolveOutboxFile(ws, "../secret.txt"), { ok: false, status: 400 });
    assert.deepEqual(resolveOutboxFile(ws, "sub/report.md"), { ok: false, status: 400 });
    assert.deepEqual(resolveOutboxFile(ws, "sub\\report.md"), { ok: false, status: 400 });
    assert.deepEqual(resolveOutboxFile(ws, ""), { ok: false, status: 400 });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("returns 404 for a missing file and for a directory", () => {
  const ws = makeWorkspace();
  try {
    assert.deepEqual(resolveOutboxFile(ws, "nope.md"), { ok: false, status: 404 });
    mkdirSync(join(ws, "outbox", "adir"));
    assert.deepEqual(resolveOutboxFile(ws, "adir"), { ok: false, status: 404 });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("returns 404 for a symlink in outbox/ pointing at a secret outside the workspace, without following it", (t) => {
  const ws = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "pixel-crew-outbox-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    // Windows 需開發者模式/管理員才能建 symlink；受限時比照現有平台限定項優雅跳過。
    try {
      symlinkSync(join(outside, "secret.txt"), join(ws, "outbox", "leak.txt"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        t.skip("symlink creation not permitted on this platform");
        return;
      }
      throw error;
    }
    // 守門成立：即使連結指向真實存在的外部檔，也一律回 404，不跟隨、不洩漏。
    assert.deepEqual(resolveOutboxFile(ws, "leak.txt"), { ok: false, status: 404 });
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// lstat 只看最後一段：outbox/ 目錄本身換成指向 workspace 外的 symlink（Windows 用 junction）時，
// 裡面的「一般檔」其實是外部檔案，必須用 realpath 確認實際位置。
test("returns 404 when outbox/ itself is a symlink to a directory outside the workspace", () => {
  const ws = mkdtempSync(join(tmpdir(), "pixel-crew-outbox-"));
  const outside = mkdtempSync(join(tmpdir(), "pixel-crew-outbox-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(outside, join(ws, "outbox"), process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(resolveOutboxFile(ws, "secret.txt"), { ok: false, status: 404 });
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("still serves files when outbox/ links to another directory inside the workspace", () => {
  const ws = mkdtempSync(join(tmpdir(), "pixel-crew-outbox-"));
  try {
    mkdirSync(join(ws, "dist"));
    writeFileSync(join(ws, "dist", "report.md"), "hello");
    symlinkSync(join(ws, "dist"), join(ws, "outbox"), process.platform === "win32" ? "junction" : "dir");
    const res = resolveOutboxFile(ws, "report.md");
    assert.equal(res.ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
