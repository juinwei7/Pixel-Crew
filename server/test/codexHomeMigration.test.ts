import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { migrateAmbientCodexHome, type CodexHomeMigrationDeps } from "../src/codexHomeMigration.js";

function fakeDeps(files: Set<string>): CodexHomeMigrationDeps & { ensured: string[]; copied: Array<[string, string]>; protected: string[] } {
  const ensured: string[] = [];
  const copied: Array<[string, string]> = [];
  const protectedFiles: string[] = [];
  return {
    existsSync: (path: any) => files.has(String(path)),
    copyFileSync: (src: any, dest: any) => { copied.push([String(src), String(dest)]); files.add(String(dest)); },
    ensureDir: (dir) => { ensured.push(dir); },
    protect: (file) => { protectedFiles.push(file); },
    ensured,
    copied,
    protected: protectedFiles,
  };
}

test("does nothing when the managed default directory is already logged in (already migrated)", () => {
  const files = new Set([join("/data/codex-home", "auth.json")]);
  const deps = fakeDeps(files);

  const result = migrateAmbientCodexHome("/data/codex-home", "/home/user/.codex", deps);

  assert.deepEqual(result, { migrated: false, copiedConfig: false });
  assert.deepEqual(deps.copied, []);
  assert.deepEqual(deps.ensured, []);
});

test("does nothing when there's nothing to migrate (fresh install, never logged in via the terminal either)", () => {
  const files = new Set<string>();
  const deps = fakeDeps(files);

  const result = migrateAmbientCodexHome("/data/codex-home", "/home/user/.codex", deps);

  assert.deepEqual(result, { migrated: false, copiedConfig: false });
  assert.deepEqual(deps.copied, []);
});

test("copies auth.json and config.toml from the ambient CODEX_HOME on first run", () => {
  const files = new Set([
    join("/home/user/.codex", "auth.json"),
    join("/home/user/.codex", "config.toml"),
  ]);
  const deps = fakeDeps(files);

  const result = migrateAmbientCodexHome("/data/codex-home", "/home/user/.codex", deps);

  assert.deepEqual(result, { migrated: true, copiedConfig: true });
  assert.deepEqual(deps.ensured, ["/data/codex-home"]);
  assert.deepEqual(deps.copied, [
    [join("/home/user/.codex", "auth.json"), join("/data/codex-home", "auth.json")],
    [join("/home/user/.codex", "config.toml"), join("/data/codex-home", "config.toml")],
  ]);
  assert.deepEqual(deps.protected, [join("/data/codex-home", "auth.json")]);
});

test("copies auth.json alone when there's no config.toml to bring along", () => {
  const files = new Set([join("/home/user/.codex", "auth.json")]);
  const deps = fakeDeps(files);

  const result = migrateAmbientCodexHome("/data/codex-home", "/home/user/.codex", deps);

  assert.deepEqual(result, { migrated: true, copiedConfig: false });
  assert.equal(deps.copied.length, 1);
});

test("a failed copy is swallowed — the owner just logs in again inside the app instead of the server refusing to start", () => {
  const files = new Set([join("/home/user/.codex", "auth.json")]);
  const deps = fakeDeps(files);
  deps.copyFileSync = () => { throw new Error("disk full"); };

  assert.doesNotThrow(() => {
    const result = migrateAmbientCodexHome("/data/codex-home", "/home/user/.codex", deps);
    assert.deepEqual(result, { migrated: false, copiedConfig: false });
  });
});
