import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appDataDirectory, defaultWorkspaceDirectory, expandHomePath, migrateLegacyData, sameWorkspace, workspaceIdentity } from "../src/platform/paths.js";

test("selects conventional per-user app data directories", () => {
  assert.equal(appDataDirectory("win32", { LOCALAPPDATA: "C:\\Users\\Wei\\AppData\\Local" }, "C:\\Users\\Wei"), "C:\\Users\\Wei\\AppData\\Local\\Pixel Crew");
  assert.equal(appDataDirectory("darwin", {}, "/Users/wei"), "/Users/wei/Library/Application Support/Pixel Crew");
  assert.equal(appDataDirectory("linux", { XDG_DATA_HOME: "/data" }, "/home/wei"), "/data/pixel-crew");
});

test("uses a dedicated workspace instead of the user home on every platform", () => {
  assert.equal(defaultWorkspaceDirectory("win32", "C:\\Users\\Wei"), "C:\\Users\\Wei\\Pixel Crew Workspace");
  assert.equal(defaultWorkspaceDirectory("darwin", "/Users/wei"), "/Users/wei/Pixel Crew Workspace");
  assert.equal(defaultWorkspaceDirectory("linux", "/home/wei"), "/home/wei/Pixel Crew Workspace");
  assert.notEqual(defaultWorkspaceDirectory("darwin", "/Users/wei"), "/Users/wei");
});

test("expands both Unix and Windows home syntax", () => {
  assert.equal(expandHomePath("~/repo", "/home/wei"), "/home/wei/repo");
  assert.equal(expandHomePath("~\\repo", "/home/wei"), "/home/wei/repo");
  assert.equal(expandHomePath("~/repo", "C:\\Users\\Wei"), "C:\\Users\\Wei\\repo");
  assert.equal(expandHomePath("~\\repo", "C:\\Users\\Wei"), "C:\\Users\\Wei\\repo");
});

test("Windows workspace identities ignore path casing", () => {
  assert.equal(workspaceIdentity("/Work/Repo", "win32"), workspaceIdentity("/work/repo", "win32"));
  assert.equal(sameWorkspace("/Work/Repo", "/work/repo", "win32"), true);
  assert.equal(sameWorkspace("/Work/Repo", "/work/repo", "linux"), false);
});

test("migrates a legacy database with its WAL sidecar without deleting the source", () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-migration-"));
  try {
    const legacy = join(root, "legacy", "cockpit.sqlite");
    const target = join(root, "new", "cockpit.sqlite");
    const legacyAvatars = join(root, "legacy", "avatars");
    const targetAvatars = join(root, "new", "avatars");
    mkdirSync(legacyAvatars, { recursive: true });
    writeFileSync(legacy, "db");
    writeFileSync(`${legacy}-wal`, "wal");
    writeFileSync(join(legacyAvatars, "crew.png"), "avatar");

    migrateLegacyData(legacy, target, targetAvatars);
    assert.equal(readFileSync(target, "utf8"), "db");
    assert.equal(readFileSync(`${target}-wal`, "utf8"), "wal");
    assert.equal(readFileSync(join(targetAvatars, "crew.png"), "utf8"), "avatar");
    assert.equal(existsSync(legacy), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
