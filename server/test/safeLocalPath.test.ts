import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { assertSafeLocalPath, pathEscapesWorkspace } from "../src/safeLocalPath.js";

test("allows a normal path inside the workspace, including one that doesn't exist yet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-safepath-"));
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "file.txt"), "hi");
    await assert.doesNotReject(assertSafeLocalPath(dir, join(dir, "nested", "file.txt")));
    // A path that doesn't exist yet (about to be created) is also fine —
    // the check exists to stop escapes, not to require the target to exist.
    await assert.doesNotReject(assertSafeLocalPath(dir, join(dir, "nested", "new-file.txt")));
    // The workspace root itself.
    await assert.doesNotReject(assertSafeLocalPath(dir, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a target that escapes the workspace via ..", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-safepath-"));
  try {
    await assert.rejects(
      assertSafeLocalPath(dir, join(dir, "..", "outside.txt")),
      /超出工作資料夾/,
    );
    await assert.rejects(assertSafeLocalPath(dir, join(dir, "..")), /超出工作資料夾/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a target reached through a symlink, even one that itself resolves back inside the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-safepath-"));
  const outside = mkdtempSync(join(tmpdir(), "pixel-crew-safepath-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(outside, join(dir, "escape-link"));
    await assert.rejects(
      assertSafeLocalPath(dir, join(dir, "escape-link", "secret.txt")),
      /符號連結/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// 通道 E 圍欄的判定核心（零 I/O 同步版）——claudeRunner 核准橋對 Write/Edit/NotebookEdit
// 用它擋掉寫到 workspace 外的路徑，不論核准模式。此處鎖住純路徑語意；full 模式整合見 claudeRunner.test.ts。
test("pathEscapesWorkspace flags absolute and relative targets that leave the workspace", () => {
  const ws = process.platform === "win32" ? "C:\\work\\ws" : "/work/ws";
  const outsideAbs = process.platform === "win32" ? "C:\\work\\secret.txt" : "/etc/passwd";
  // 逃逸：外部絕對路徑、../ 穿越、workspace 的兄弟目錄前綴。
  assert.equal(pathEscapesWorkspace(ws, outsideAbs), true);
  assert.equal(pathEscapesWorkspace(ws, "../secret.txt"), true);
  assert.equal(pathEscapesWorkspace(ws, "nested/../../secret.txt"), true);
  assert.equal(pathEscapesWorkspace(ws, join(ws, "..", "ws-evil", "x.txt")), true);
});

test("pathEscapesWorkspace allows targets inside the workspace, including outbox/", () => {
  const ws = process.platform === "win32" ? "C:\\work\\ws" : "/work/ws";
  assert.equal(pathEscapesWorkspace(ws, join(ws, "report.md")), false);
  assert.equal(pathEscapesWorkspace(ws, join(ws, "outbox", "final.pdf")), false);
  assert.equal(pathEscapesWorkspace(ws, "outbox/final.pdf"), false); // workspace 相對路徑
  assert.equal(pathEscapesWorkspace(ws, "nested/deep/file.txt"), false);
  assert.equal(pathEscapesWorkspace(ws, ws), false); // workspace 根本身
});

// Windows 上跨磁碟／UNC／\\?\ 目標跟 workspace 沒有共同根：relative() 回傳的是絕對路徑而不是 ..\ 開頭，
// 舊判定會把它們當成「在 workspace 內」放行。用 path.win32 在任何平台上鎖住這個語意。
test("pathEscapesWorkspace flags Windows other-drive, UNC and \\\\?\\ targets", () => {
  const ws = "C:\\work\\ws";
  for (const target of ["D:\\secret.txt", "\\\\server\\share\\secret.txt", "\\\\?\\C:\\work\\secret.txt", "\\\\.\\C:\\work\\secret.txt", "..\\secret.txt"]) {
    assert.equal(pathEscapesWorkspace(ws, target, win32), true, target);
  }
  for (const target of ["C:\\work\\ws\\outbox\\report.md", "outbox\\report.md", "c:\\WORK\\ws\\a.txt"]) {
    assert.equal(pathEscapesWorkspace(ws, target, win32), false, target);
  }
});

test("assertSafeLocalPath rejects other-drive and UNC targets on Windows", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-safepath-"));
  try {
    const otherDrive = dir.toUpperCase().startsWith("Z:") ? "Y:\\secret.txt" : "Z:\\secret.txt";
    await assert.rejects(assertSafeLocalPath(dir, otherDrive), /超出工作資料夾/);
    await assert.rejects(assertSafeLocalPath(dir, "\\\\server\\share\\secret.txt"), /超出工作資料夾/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
