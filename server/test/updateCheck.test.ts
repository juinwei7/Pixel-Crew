import assert from "node:assert/strict";
import test from "node:test";
import { isNewerVersion, isRootManifestName, parseSemver, readCurrentVersion, UpdateChecker } from "../src/updateCheck.js";

test("parses release tags with or without the v prefix, rejects everything else", () => {
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("1.2.3"), [1, 2, 3]);
  assert.equal(parseSemver("v1.2"), null);
  assert.equal(parseSemver("v1.2.3-beta.1"), null);
  assert.equal(parseSemver("latest"), null);
});

test("compares versions numerically, not lexically", () => {
  assert.equal(isNewerVersion("1.0.0", "1.0.1"), true);
  assert.equal(isNewerVersion("1.0.0", "v1.1.0"), true);
  assert.equal(isNewerVersion("1.9.0", "1.10.0"), true);
  assert.equal(isNewerVersion("2.0.0", "10.0.0"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("1.1.0", "1.0.9"), false);
  // Unparseable candidates never count as updates.
  assert.equal(isNewerVersion("1.0.0", "2.0.0-rc.1"), false);
});

test("reads the workspace root version as the single source of truth", () => {
  const version = readCurrentVersion();
  assert.notEqual(version, "0.0.0");
  assert.ok(parseSemver(version), `expected semver, got ${version}`);
});

test("accepts both the dev repo name and scripts/package.mjs's scoped release name", () => {
  // Regression: scripts/package.mjs rewrites the shipped package.json's name
  // to "@juinwei7/pixel-crew" for npm publishing, which used to make every
  // packaged release fall back to reporting version "0.0.0".
  assert.equal(isRootManifestName("pixel-crew"), true);
  assert.equal(isRootManifestName("@juinwei7/pixel-crew"), true);
  assert.equal(isRootManifestName("some-other-package"), false);
  assert.equal(isRootManifestName(undefined), false);
});

test("update info reports no update until a newer release is known", () => {
  const checker = new UpdateChecker("1.0.0");
  const info = checker.getInfo();
  assert.equal(info.currentVersion, "1.0.0");
  assert.equal(info.latestVersion, null);
  assert.equal(info.updateAvailable, false);
  assert.equal(info.oneClickAvailable, false);
  assert.match(info.releaseUrl ?? "", /github\.com\/juinwei7\/Pixel-Crew\/releases/);
});
