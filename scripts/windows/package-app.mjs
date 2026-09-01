import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_VERSION = "22.23.1";
const PE_MACHINE_X64 = 0x8664;
const scriptPath = resolve(fileURLToPath(import.meta.url));

export function readPeMachine(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error("runtime is not a valid PE executable");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.subarray(peOffset, peOffset + 4).toString("binary") !== "PE\0\0") {
    throw new Error("runtime has an invalid PE header");
  }
  return buffer.readUInt16LE(peOffset + 4);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows x64 packaging must run on a Windows x64 host");
  }

  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const options = parseArgs(process.argv.slice(2));
  const controllerProject = join(root, "windows", "PixelCrewController", "PixelCrewController.csproj");
  const runtimeRoot = resolveRequired(options.runtime, "--runtime is required");
  const runtimeNode = join(runtimeRoot, "node.exe");
  const runtimeLicense = join(runtimeRoot, "LICENSE");
  await requireFile(runtimeNode, "Node runtime executable");
  await requireFile(runtimeLicense, "Node runtime license");

  const version = execFileSync(runtimeNode, ["--version"], { encoding: "utf8" }).trim();
  if (version !== `v${EXPECTED_NODE_VERSION}`) {
    throw new Error(`Expected Node v${EXPECTED_NODE_VERSION}, received ${version}`);
  }
  if (readPeMachine(await readFile(runtimeNode)) !== PE_MACHINE_X64) {
    throw new Error("Node runtime is not a Windows x64 executable");
  }

  const portableRoot = join(root, "release", "pixel-crew");
  await requireFile(controllerProject, "Pixel Crew control center project");
  await requireFile(join(portableRoot, "server", "dist", "index.js"), "packaged server");
  await requireFile(join(portableRoot, "web", "dist", "index.html"), "packaged web app");

  const outputRoot = resolve(options.output ?? join(root, "release", "windows", "x64"));
  const payloadRoot = join(outputRoot, "payload");
  const payloadArchive = join(outputRoot, "pixel-crew-payload.zip");
  const publishRoot = join(outputRoot, "publish");
  const outputExecutable = join(outputRoot, "Pixel Crew.exe");
  const bundledRuntime = join(payloadRoot, "runtime");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(portableRoot, payloadRoot, { recursive: true });
  await mkdir(bundledRuntime, { recursive: true });
  await cp(runtimeNode, join(bundledRuntime, "node.exe"));
  await cp(runtimeLicense, join(bundledRuntime, "LICENSE"));

  for (const path of [
    "install-pixel-crew-macos.sh",
    "MACOS_SETUP.md",
    "install-pixel-crew.cmd",
    "scripts/windows/install-release.ps1",
    "scripts/windows/setup-windows.cmd",
    "scripts/windows/setup-windows.ps1",
  ]) {
    await rm(join(payloadRoot, path), { force: true });
  }

  const command = "npm.cmd ci --omit=dev --workspace server --include-workspace-root --ignore-scripts";
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    cwd: payloadRoot,
    stdio: "inherit",
  });
  await rm(join(payloadRoot, "scripts", "windows", "pixel-crew-tray.ps1"), { force: true });
  await rm(join(payloadRoot, "scripts", "windows", "start-pixel-crew.ps1"), { force: true });
  await auditBundle(payloadRoot, payloadRoot);

  execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(root, "scripts", "windows", "create-payload.ps1"),
    "-Source", payloadRoot,
    "-Output", payloadArchive,
  ], { cwd: root, stdio: "inherit" });
  await requireFile(payloadArchive, "Pixel Crew embedded payload");

  // The only user-facing Windows release file is this self-contained EXE. Its
  // managed payload is extracted privately into LocalAppData on first launch.
  execFileSync("dotnet", [
    "publish", controllerProject,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "true",
    "--output", publishRoot,
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=None",
    "-p:DebugSymbols=false",
    `-p:PixelCrewPayload=${payloadArchive}`,
  ], { cwd: root, stdio: "inherit" });
  const publishedExecutable = join(publishRoot, "Pixel Crew.exe");
  await requireFile(publishedExecutable, "Pixel Crew control center executable");
  if (readPeMachine(await readFile(publishedExecutable)) !== PE_MACHINE_X64) {
    throw new Error("Pixel Crew control center is not a Windows x64 executable");
  }
  await cp(publishedExecutable, outputExecutable);
  await rm(payloadRoot, { recursive: true, force: true });
  await rm(payloadArchive, { force: true });
  await rm(publishRoot, { recursive: true, force: true });
  await auditSingleFileRelease(outputRoot);
  console.log(`Single-file Windows x64 release staged at ${outputExecutable}`);
}

function parseArgs(args) {
  const parsed = {};
  const supported = new Set(["runtime", "output"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? ""}`);
    const name = key.slice(2);
    if (!supported.has(name)) throw new Error(`Unknown option: ${key}`);
    parsed[name] = value;
  }
  return parsed;
}

function resolveRequired(value, message) {
  if (!value) throw new Error(message);
  return resolve(value);
}

async function requireFile(path, label) {
  try {
    if (!(await stat(path)).isFile()) throw new Error();
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function auditBundle(directory, bundleRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await auditBundle(path, bundleRoot);
      continue;
    }
    const name = basename(path);
    if (/^(\.env(?:\..*)?|\.DS_Store)$/.test(name) || /\.(sqlite(?:-(?:wal|shm))?|log)$/i.test(name)) {
      throw new Error(`Windows bundle contains forbidden local file: ${relative(bundleRoot, path)}`);
    }
  }
}

async function auditSingleFileRelease(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== "Pixel Crew.exe" || !entries[0].isFile()) {
    throw new Error("Windows release must contain exactly one user-facing Pixel Crew.exe");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
