import assert from "node:assert/strict";
import test from "node:test";
import { bundledWindowsRoot, releaseVersion, windowsReleaseAssetUrl } from "../src/selfUpdate.js";

test("only recognizes the complete bundled Windows release layout", () => {
  const root = "C:\\Users\\Ada\\Apps\\Pixel Crew";
  const files = new Set([
    `${root}\\start-pixel-crew.vbs`,
    `${root}\\server\\dist\\index.js`,
    `${root}\\web\\dist\\index.html`,
    `${root}\\scripts\\windows\\self-update.ps1`,
  ]);
  assert.equal(
    bundledWindowsRoot("win32", `${root}\\runtime\\node.exe`, (path) => files.has(path)),
    root,
  );
  assert.equal(bundledWindowsRoot("darwin", `${root}\\runtime\\node.exe`, () => true), null);
  assert.equal(bundledWindowsRoot("win32", "C:\\Program Files\\nodejs\\node.exe", () => true), null);
  files.delete(`${root}\\scripts\\windows\\self-update.ps1`);
  assert.equal(bundledWindowsRoot("win32", `${root}\\runtime\\node.exe`, (path) => files.has(path)), null);
});

test("release download URLs accept only exact stable semver versions", () => {
  assert.equal(releaseVersion("v2.1.1"), null);
  assert.equal(releaseVersion("2.1.1"), "2.1.1");
  assert.equal(releaseVersion("2.1.1-beta"), null);
  assert.equal(
    windowsReleaseAssetUrl("2.1.1"),
    "https://github.com/juinwei7/Pixel-Crew/releases/download/v2.1.1/pixel-crew-windows-x64.zip",
  );
  assert.throws(() => windowsReleaseAssetUrl("../../latest"), /Invalid release version/);
});
