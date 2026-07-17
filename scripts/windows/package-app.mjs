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
  await requireFile(join(portableRoot, "server", "dist", "index.js"), "packaged server");
  await requireFile(join(portableRoot, "web", "dist", "index.html"), "packaged web app");

  const outputRoot = resolve(options.output ?? join(root, "release", "windows", "x64"));
  const bundle = join(outputRoot, "Pixel Crew");
  const bundledRuntime = join(bundle, "runtime");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(portableRoot, bundle, { recursive: true });
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
    await rm(join(bundle, path), { force: true });
  }

  const command = "npm.cmd ci --omit=dev --workspace server --include-workspace-root --ignore-scripts";
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    cwd: bundle,
    stdio: "inherit",
  });

  await auditBundle(bundle, bundle);
  console.log(`Windows x64 bundle staged at ${bundle}`);
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

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
