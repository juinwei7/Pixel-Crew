import { win32 } from "node:path";

const RELEASE_OWNER = "juinwei7";
const RELEASE_REPOSITORY = "Pixel-Crew";
const WINDOWS_ASSET = "Pixel Crew.exe";

/** A one-click update is deliberately restricted to the verified, bundled
 * Windows layout. Source checkouts continue to use their normal git workflow. */
export function bundledWindowsRoot(
  platform: NodeJS.Platform,
  execPath: string,
  exists: (path: string) => boolean,
): string | null {
  if (platform !== "win32" || win32.basename(execPath).toLowerCase() !== "node.exe") return null;
  const runtime = win32.dirname(execPath);
  if (win32.basename(runtime).toLowerCase() !== "runtime") return null;
  const root = win32.dirname(runtime);
  const required = [
    win32.join(root, "Pixel Crew.exe"),
    win32.join(root, "server", "dist", "index.js"),
    win32.join(root, "web", "dist", "index.html"),
    win32.join(root, "scripts", "windows", "self-update.ps1"),
  ];
  return required.every(exists) ? root : null;
}

export function releaseVersion(value: string | null | undefined): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value?.trim() ?? "");
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

export function windowsReleaseAssetUrl(version: string): string {
  const validVersion = releaseVersion(version);
  if (!validVersion) throw new Error("Invalid release version");
  return `https://github.com/${RELEASE_OWNER}/${RELEASE_REPOSITORY}/releases/download/v${validVersion}/${encodeURIComponent(WINDOWS_ASSET)}`;
}
