import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// @ts-expect-error The release packager is intentionally plain JavaScript.
import { readPeMachine } from "../../scripts/windows/package-app.mjs";

const startScript = fileURLToPath(new URL("../../scripts/windows/start-pixel-crew.ps1", import.meta.url));
const commandLauncher = fileURLToPath(new URL("../../start-pixel-crew.cmd", import.meta.url));
const backgroundLauncher = fileURLToPath(new URL("../../start-pixel-crew.vbs", import.meta.url));
const restartLauncher = fileURLToPath(new URL("../../relaunch-pixel-crew.ps1", import.meta.url));
const portablePackager = fileURLToPath(new URL("../../scripts/package.mjs", import.meta.url));
const trayController = fileURLToPath(new URL("../../scripts/windows/pixel-crew-tray.ps1", import.meta.url));

function peHeader(machine: number): Buffer {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "binary");
  buffer.writeUInt16LE(machine, 68);
  return buffer;
}

test("Windows packager accepts only a structurally valid PE machine header", () => {
  assert.equal(readPeMachine(peHeader(0x8664)), 0x8664);
  assert.equal(readPeMachine(peHeader(0xaa64)), 0xaa64);
  assert.throws(() => readPeMachine(Buffer.from("not a PE file")), /valid PE executable/);

  const invalidSignature = peHeader(0x8664);
  invalidSignature.write("NOPE", 64, "ascii");
  assert.throws(() => readPeMachine(invalidSignature), /invalid PE header/);
});

test("Windows launcher prefers the bundled runtime and exposes it on PATH", () => {
  const source = readFileSync(startScript, "utf8");
  assert.match(source, /runtime["\\]/i);
  assert.match(source, /Test-Path \$BundledNode/);
  assert.match(source, /\$env:Path = "\$BundledRuntime;\$env:Path"/);
  assert.match(source, /FilePath = \$NodeExe/);
  assert.match(source, /Start-Process @StartOptions/);
});

test("Windows normal launch is background-only, while console diagnostics remain opt-in", () => {
  const startSource = readFileSync(startScript, "utf8");
  const commandSource = readFileSync(commandLauncher, "utf8");
  const vbsSource = readFileSync(backgroundLauncher, "utf8");
  const restartSource = readFileSync(restartLauncher, "utf8");
  const packagerSource = readFileSync(portablePackager, "utf8");
  const traySource = readFileSync(trayController, "utf8");

  assert.match(commandSource, /wscript\.exe/i);
  assert.match(commandSource, /-Console/i);
  assert.match(vbsSource, /start-pixel-crew\.ps1/i);
  assert.match(vbsSource, /, 0, False/);
  assert.match(startSource, /\[switch\]\$Background/);
  assert.match(startSource, /WindowStyle\s*=\s*"Hidden"/);
  assert.match(startSource, /RedirectStandardOutput/);
  assert.match(startSource, /RedirectStandardError/);
  assert.match(startSource, /pixel-crew-tray\.ps1/);
  assert.match(startSource, /MessageBox/);
  assert.match(restartSource, /wscript\.exe/i);
  assert.match(restartSource, /start-pixel-crew\.vbs/i);
  assert.match(packagerSource, /start-pixel-crew\.vbs/);
  assert.match(traySource, /NotifyIcon/);
  assert.match(traySource, /Restart service/);
  assert.match(traySource, /Stop service/);
  assert.match(traySource, /Open logs/);
});
