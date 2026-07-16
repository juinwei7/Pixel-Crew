import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDirectorySync } from "../src/platform/fileProtection.js";

test("does not change permissions of an existing parent directory", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(join(tmpdir(), "pixel-crew-parent-"));
  try {
    const before = statSync(parent).mode & 0o777;
    ensurePrivateDirectorySync(parent);
    assert.equal(statSync(parent).mode & 0o777, before);
    const child = join(parent, "private");
    ensurePrivateDirectorySync(child);
    assert.equal(statSync(child).mode & 0o777, 0o700);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
