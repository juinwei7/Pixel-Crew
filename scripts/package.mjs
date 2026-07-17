import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releaseRoot = join(root, "release", "pixel-crew");

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(join(releaseRoot, "server"), { recursive: true });
await mkdir(join(releaseRoot, "web"), { recursive: true });
await mkdir(join(releaseRoot, "scripts", "windows"), { recursive: true });

for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
  await cp(join(root, file), join(releaseRoot, file));
}
await cp(join(root, "server", "package.json"), join(releaseRoot, "server", "package.json"));
await cp(join(root, "server", "dist"), join(releaseRoot, "server", "dist"), { recursive: true });
await cp(join(root, "web", "package.json"), join(releaseRoot, "web", "package.json"));
await cp(join(root, "web", "dist"), join(releaseRoot, "web", "dist"), { recursive: true });
await cp(join(root, "scripts", "windows"), join(releaseRoot, "scripts", "windows"), { recursive: true });
await cp(join(root, "start-pixel-crew.cmd"), join(releaseRoot, "start-pixel-crew.cmd"));
await cp(join(root, "install-pixel-crew.cmd"), join(releaseRoot, "install-pixel-crew.cmd"));
await cp(join(root, "WINDOWS_SETUP.md"), join(releaseRoot, "WINDOWS_SETUP.md"));

// The release has no source/dev dependencies. Keep the workspace layout so
// npm can install only server production packages from the existing lockfile.
const manifestPath = join(releaseRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifest.devDependencies;
delete manifest.private;
manifest.name = "@juinwei7/pixel-crew";
manifest.publishConfig = { access: "public" };
manifest.scripts = { start: "npm run start -w server" };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

async function auditRelease(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = basename(path);
    const releasePath = relative(releaseRoot, path);
    if (entry.isDirectory()) {
      if (["node_modules", ".git"].includes(name)) throw new Error(`release contains forbidden directory: ${releasePath}`);
      await auditRelease(path);
      continue;
    }
    if (/^(\.env(?:\..*)?|\.DS_Store)$/.test(name) || /\.(sqlite(?:-(?:wal|shm))?|log)$/i.test(name)) {
      throw new Error(`release contains forbidden local file: ${releasePath}`);
    }
    const info = await stat(path);
    if (info.size <= 2 * 1024 * 1024 && /\.(?:js|json|md|html|css|cmd|ps1)$/i.test(name)) {
      const content = await readFile(path, "utf8");
      for (const home of [process.env.HOME, process.env.USERPROFILE].filter(Boolean)) {
        if (home.length > 3 && content.includes(home)) throw new Error(`release leaks a local home path in ${releasePath}`);
      }
    }
  }
}
await auditRelease(releaseRoot);

console.log(`Portable release staged at ${releaseRoot}`);
