import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSafeLocalPath } from "../src/safeLocalPath.js";

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
