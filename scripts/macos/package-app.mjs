import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_VERSION = "22.23.1";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const options = parseArgs(process.argv.slice(2));
const supportedOptions = new Set(["arch", "runtime", "output", "launcher", "sign"]);
for (const option of Object.keys(options)) {
  if (!supportedOptions.has(option)) throw new Error(`Unknown option: --${option}`);
}
const arch = options.arch ?? ({ arm64: "arm64", x64: "x64" })[process.arch];
if (arch !== "arm64" && arch !== "x64") throw new Error("--arch must be arm64 or x64");
if (process.platform !== "darwin") throw new Error("macOS app packaging must run on macOS");

const runtimeRoot = resolveRequired(options.runtime, "--runtime is required");
const runtimeNode = join(runtimeRoot, "bin", "node");
const runtimeLicense = join(runtimeRoot, "LICENSE");
await requireFile(runtimeNode, "Node runtime executable");
await requireFile(runtimeLicense, "Node runtime license");
const actualVersion = execFileSync(runtimeNode, ["--version"], { encoding: "utf8" }).trim();
if (actualVersion !== `v${EXPECTED_NODE_VERSION}`) {
  throw new Error(`Expected Node v${EXPECTED_NODE_VERSION}, received ${actualVersion}`);
}
validateMachArchitecture(runtimeNode, arch, "Node runtime");

const releaseRoot = join(root, "release", "pixel-crew");
await requireFile(join(releaseRoot, "server", "dist", "index.js"), "packaged server");
await requireFile(join(releaseRoot, "web", "dist", "index.html"), "packaged web app");

const outputRoot = resolve(options.output ?? join(root, "release", "macos", arch));
const bundle = join(outputRoot, "Pixel Crew.app");
const contents = join(bundle, "Contents");
const executable = join(contents, "MacOS", "Pixel Crew");
const resources = join(contents, "Resources");
const packagedApp = join(resources, "app");
const packagedRuntime = join(resources, "runtime");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(packagedRuntime, "bin"), { recursive: true });
await cp(releaseRoot, packagedApp, { recursive: true });
await cp(runtimeNode, join(packagedRuntime, "bin", "node"), { recursive: true });
await cp(runtimeLicense, join(packagedRuntime, "LICENSE"));
await chmod(join(packagedRuntime, "bin", "node"), 0o755);

execFileSync("npm", [
  "ci",
  "--omit=dev",
  "--workspace", "server",
  "--include-workspace-root",
  "--ignore-scripts",
], { cwd: packagedApp, stdio: "inherit" });

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(contents, "Info.plist"), infoPlist(manifest.version ?? "0.0.0", arch));

if (options.launcher) {
  await cp(resolve(options.launcher), executable);
} else {
  const target = arch === "arm64" ? "arm64-apple-macos11" : "x86_64-apple-macos11";
  execFileSync("xcrun", [
    "swiftc",
    "-O",
    "-target", target,
    "-framework", "AppKit",
    join(root, "scripts", "macos", "PixelCrewLauncher.swift"),
    "-o", executable,
  ], { stdio: "inherit", env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "11.0" } });
}
await chmod(executable, 0o755);
validateMachArchitecture(executable, arch, "Pixel Crew launcher");

if (options.sign !== "false") {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "inherit" });
}
await auditBundle(bundle);
console.log(`macOS ${arch} app staged at ${bundle}`);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? ""}`);
    parsed[key.slice(2)] = value;
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

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function infoPlist(version, bundleArch) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Pixel Crew</string>
  <key>CFBundleExecutable</key><string>Pixel Crew</string>
  <key>CFBundleIdentifier</key><string>com.juinwei7.pixelcrew</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Pixel Crew</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(version)}</string>
  <key>CFBundleVersion</key><string>${xml(version)}</string>
  <key>LSArchitecturePriority</key><array><string>${bundleArch === "arm64" ? "arm64" : "x86_64"}</string></array>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

function validateMachArchitecture(path, expectedArch, label) {
  const architectures = execFileSync("lipo", ["-archs", path], { encoding: "utf8" }).trim().split(/\s+/);
  const expected = expectedArch === "x64" ? "x86_64" : "arm64";
  if (!architectures.includes(expected)) {
    throw new Error(`${label} does not contain the expected ${expected} architecture: ${architectures.join(", ")}`);
  }
}

async function auditBundle(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const bundlePath = relative(directory, path);
    if (entry.isDirectory()) {
      await auditBundle(path);
      continue;
    }
    const name = basename(path);
    if (/^(\.env(?:\..*)?|\.DS_Store)$/.test(name) || /\.(sqlite(?:-(?:wal|shm))?|log)$/i.test(name)) {
      throw new Error(`macOS app contains forbidden local file: ${bundlePath}`);
    }
  }
}
