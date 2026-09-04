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
const selfUpdateHelper = fileURLToPath(new URL("../../scripts/windows/self-update.ps1", import.meta.url));
const serverEntrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const controllerProject = fileURLToPath(new URL("../../windows/PixelCrewController/PixelCrewController.csproj", import.meta.url));
const controllerSource = fileURLToPath(new URL("../../windows/PixelCrewController/Program.cs", import.meta.url));
const windowsPackager = fileURLToPath(new URL("../../scripts/windows/package-app.mjs", import.meta.url));
const releaseWorkflow = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

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
  assert.match(vbsSource, /Pixel Crew\.exe/i);
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

test("Windows release ships a self-contained native Pixel Crew control center", () => {
  const project = readFileSync(controllerProject, "utf8");
  const source = readFileSync(controllerSource, "utf8");
  const packager = readFileSync(windowsPackager, "utf8");

  assert.match(project, /net8\.0-windows/);
  assert.match(project, /UseWindowsForms>true/);
  assert.match(project, /PublishSingleFile>true/);
  assert.match(project, /SelfContained>true/);
  assert.match(project, /AssemblyName>Pixel Crew</);
  assert.match(project, /PixelCrewPayload/);
  assert.match(source, /SingleFileInstaller/);
  assert.match(source, /LocalApplicationData/);
  assert.match(source, /payload\.zip/);
  assert.match(source, /ExtractToDirectory/);
  assert.match(source, /app-staging-/);
  assert.match(source, /runtime", "node\.exe/);
  assert.match(source, /NotifyIcon/);
  assert.match(source, /重新啟動/);
  assert.match(source, /停止/);
  assert.match(source, /查看記錄/);
  assert.match(source, /開機自動啟動/);
  assert.match(source, /查看詳細資料/);
  assert.match(source, /只關閉圖示/);
  assert.match(source, /停止服務並結束/);
  assert.match(source, /Registry\.CurrentUser/);
  assert.match(source, /CurrentVersion\\Run/);
  assert.match(packager, /dotnet", \[/);
  assert.match(packager, /--self-contained/);
  assert.match(packager, /Pixel Crew\.exe/);
  assert.match(packager, /create-payload\.ps1/);
  assert.match(packager, /PixelCrewPayload/);
  assert.match(packager, /auditSingleFileRelease/);
  assert.match(packager, /pixel-crew-tray\.ps1/);
  assert.match(packager, /node-pty["),\s]/);
  assert.match(packager, /prebuilds["),\s]/);
  assert.match(packager, /win32-x64/);
  assert.match(packager, /conpty\.node/);
  assert.match(packager, /winpty-agent\.exe/);
});

test("server restart uses graceful shutdown after the detached launcher starts", () => {
  const source = readFileSync(serverEntrypoint, "utf8");

  assert.match(source, /launcher\.once\("spawn", \(\) => \{\s*started = true;\s*finishServerRestart\(\);/);
  assert.match(source, /exitAfterShutdown\("planned restart", 0\)/);
  assert.match(source, /app\.get\("\/api\/restart-server\/status"/);
});

test("Windows self-update verifies the published single-file app before handing over", () => {
  const source = readFileSync(selfUpdateHelper, "utf8");
  const entrypoint = readFileSync(serverEntrypoint, "utf8");

  assert.match(source, /SHA256SUMS\.txt/);
  assert.match(source, /Get-FileHash[\s\S]*SHA256/);
  assert.match(source, /Pixel Crew\.exe/);
  assert.match(source, /EscapeDataString/);
  assert.match(source, /Start-Process -FilePath \$installer/);
  assert.match(source, /update\.pending/);
  assert.match(source, /Get-Process -Name "Pixel Crew"/);
  assert.match(source, /Pixel Crew\.exe/);
  assert.match(source, /self-update-error\.log/);
  assert.match(entrypoint, /app\.post\("\/api\/update\/apply"/);
  assert.match(entrypoint, /workerSummary\(worker\)\.busy/);
  assert.match(entrypoint, /exitAfterShutdown\("self update", 0\)/);
});

test("GitHub Release exposes only end-user platform assets", () => {
  const workflow = readFileSync(releaseWorkflow, "utf8");
  const releaseFiles = workflow.split("files: |", 2)[1]?.split("Publish package to npm", 1)[0] ?? "";

  assert.match(releaseFiles, /pixel-crew-macos-arm64\.tar\.gz/);
  assert.match(releaseFiles, /pixel-crew-macos-x64\.tar\.gz/);
  assert.match(releaseFiles, /Pixel Crew\.exe/);
  assert.match(releaseFiles, /install-pixel-crew-macos\.sh/);
  assert.match(releaseFiles, /SHA256SUMS\.txt/);
  assert.doesNotMatch(releaseFiles, /portable\.(?:tar\.gz|zip)/);
  assert.doesNotMatch(releaseFiles, /pixel-crew-windows-x64\.zip/);
});
