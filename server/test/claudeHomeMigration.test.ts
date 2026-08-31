import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { migrateAmbientClaudeHome, type ClaudeHomeMigrationDeps } from "../src/claudeHomeMigration.js";

function fakeDeps(files: Set<string>): ClaudeHomeMigrationDeps & { ensured: string[]; copied: Array<[string, string]>; protected: string[] } {
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

test("does nothing when the managed default directory already has a .claude.json (already migrated)", () => {
  const files = new Set([join("/data/claude-home", ".claude.json")]);
  const deps = fakeDeps(files);

  const result = migrateAmbientClaudeHome("/data/claude-home", "/home/user", deps);

  assert.deepEqual(result, { migrated: false });
  assert.deepEqual(deps.copied, []);
});

test("does nothing when there's no ambient ~/.claude.json to migrate (fresh install)", () => {
  const files = new Set<string>();
  const deps = fakeDeps(files);

  const result = migrateAmbientClaudeHome("/data/claude-home", "/home/user", deps);

  assert.deepEqual(result, { migrated: false });
  assert.deepEqual(deps.copied, []);
});

test("copies ~/.claude.json into the managed directory on first run", () => {
  const files = new Set([join("/home/user", ".claude.json")]);
  const deps = fakeDeps(files);

  const result = migrateAmbientClaudeHome("/data/claude-home", "/home/user", deps);

  assert.deepEqual(result, { migrated: true });
  assert.deepEqual(deps.ensured, ["/data/claude-home"]);
  assert.deepEqual(deps.copied, [[join("/home/user", ".claude.json"), join("/data/claude-home", ".claude.json")]]);
  assert.deepEqual(deps.protected, [join("/data/claude-home", ".claude.json")]);
});

test("a failed copy is swallowed — the owner just logs in again inside the app instead of the server refusing to start", () => {
  const files = new Set([join("/home/user", ".claude.json")]);
  const deps = fakeDeps(files);
  deps.copyFileSync = () => { throw new Error("disk full"); };

  assert.doesNotThrow(() => {
    const result = migrateAmbientClaudeHome("/data/claude-home", "/home/user", deps);
    assert.deepEqual(result, { migrated: false });
  });
});
