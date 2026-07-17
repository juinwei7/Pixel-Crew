import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installer = fileURLToPath(new URL("../../scripts/macos/install-release.sh", import.meta.url));
const supportedPlatform = process.platform !== "win32";

function writeFixture(releaseDirectory: string, arch: "arm64" | "x64", marker: string): void {
  const payload = join(dirname(releaseDirectory), `payload-${arch}`);
  const app = join(payload, "Pixel Crew.app");
  const launcher = join(app, "Contents", "MacOS", "Pixel Crew");
  const runtime = join(app, "Contents", "Resources", "runtime", "bin", "node");
  const server = join(app, "Contents", "Resources", "app", "server", "dist", "index.js");
  const web = join(app, "Contents", "Resources", "app", "web", "dist", "index.html");
  for (const path of [launcher, runtime, server, web]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\n# ${marker}\n`);
  writeFileSync(runtime, "#!/bin/sh\n");
  writeFileSync(server, marker);
  writeFileSync(web, "<!doctype html>");
  chmodSync(launcher, 0o755);
  chmodSync(runtime, 0o755);

  mkdirSync(releaseDirectory, { recursive: true });
  const archiveName = `pixel-crew-macos-${arch}.tar.gz`;
  const archive = join(releaseDirectory, archiveName);
  const packed = spawnSync("tar", ["-czf", archive, "-C", payload, "Pixel Crew.app"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(releaseDirectory, "SHA256SUMS.txt"), `${checksum}  ${archiveName}\n`);
  rmSync(payload, { recursive: true, force: true });
}

function runInstaller(root: string, arch = "arm64", args: string[] = []) {
  const releaseDirectory = join(root, "release");
  return spawnSync("bash", [installer, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(root, "home"),
      PIXEL_CREW_ARCH_OVERRIDE: arch,
      PIXEL_CREW_INSTALL_ROOT: join(root, "install"),
      PIXEL_CREW_RELEASE_BASE_URL: pathToFileURL(releaseDirectory).href,
      PIXEL_CREW_SKIP_LAUNCH: "1",
    },
  });
}

test("certificate-free macOS installer installs, upgrades, and uninstalls without deleting user data", {
  skip: !supportedPlatform,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-macos-installer-"));
  try {
    const releaseDirectory = join(root, "release");
    writeFixture(releaseDirectory, "arm64", "first");
    let result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const installedServer = join(root, "install", "Pixel Crew.app", "Contents", "Resources", "app", "server", "dist", "index.js");
    assert.equal(readFileSync(installedServer, "utf8"), "first");

    writeFixture(releaseDirectory, "arm64", "second");
    result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(installedServer, "utf8"), "second");

    const userData = join(root, "home", "Library", "Application Support", "Pixel Crew", "keep.txt");
    mkdirSync(dirname(userData), { recursive: true });
    writeFileSync(userData, "keep");
    result = runInstaller(root, "arm64", ["--uninstall"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, "install", "Pixel Crew.app")), false);
    assert.equal(readFileSync(userData, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("certificate-free macOS installer rejects corrupted and unsupported releases", {
  skip: !supportedPlatform,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-macos-installer-invalid-"));
  try {
    const releaseDirectory = join(root, "release");
    writeFixture(releaseDirectory, "arm64", "valid");
    writeFileSync(join(releaseDirectory, "SHA256SUMS.txt"), `${"0".repeat(64)}  pixel-crew-macos-arm64.tar.gz\n`);
    let result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, "install", "Pixel Crew.app")), false);

    writeFixture(releaseDirectory, "arm64", "valid-again");
    const checksumFile = join(releaseDirectory, "SHA256SUMS.txt");
    const checksumLine = readFileSync(checksumFile, "utf8");
    writeFileSync(checksumFile, checksumLine + checksumLine);
    result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, "install", "Pixel Crew.app")), false);

    result = runInstaller(root, "powerpc");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported Mac architecture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
