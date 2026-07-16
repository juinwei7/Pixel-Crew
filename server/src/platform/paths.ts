import { chmodSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";

export type PlatformName = NodeJS.Platform;

export function appDataDirectory(
  platform: PlatformName = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === "win32") {
    return win32.join(env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local"), "Pixel Crew");
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Pixel Crew");
  return posix.join(env.XDG_DATA_HOME?.trim() || posix.join(home, ".local", "share"), "pixel-crew");
}

export function defaultWorkspaceDirectory(
  platform: PlatformName = process.platform,
  home = homedir(),
): string {
  return platform === "win32"
    ? win32.join(home, "Pixel Crew Workspace")
    : posix.join(home, "Pixel Crew Workspace");
}

export function expandHomePath(value: string, home = homedir()): string {
  const input = value.trim();
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    const pathApi = /^[a-z]:[\\/]/i.test(home) || home.startsWith("\\\\") ? win32 : posix;
    return pathApi.resolve(home, input.slice(2));
  }
  return input;
}

export function workspaceIdentity(value: string, platform: PlatformName = process.platform): string {
  const normalized = normalize(resolve(value)).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.replaceAll("/", "\\").toLocaleLowerCase("en-US") : normalized;
}

export function sameWorkspace(left: string, right: string, platform: PlatformName = process.platform): boolean {
  try {
    return workspaceIdentity(realpathSync(left), platform) === workspaceIdentity(realpathSync(right), platform);
  } catch {
    return workspaceIdentity(left, platform) === workspaceIdentity(right, platform);
  }
}

export function canonicalWorkspacePath(input: unknown, fallback: string): string {
  const requested = String(input ?? "").trim() || fallback;
  const expanded = expandHomePath(requested);
  if (!isAbsolute(expanded)) throw new Error("請輸入本機絕對路徑");
  if (process.platform === "win32" && /^\\\\/.test(expanded)) {
    throw new Error("目前 Windows 版本先支援本機磁碟；UNC 與 WSL 網路路徑尚未開放");
  }
  try {
    const canonical = realpathSync(expanded);
    if (!statSync(canonical).isDirectory()) throw new Error("工作位置不是資料夾");
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("找不到這個資料夾，請確認本機絕對路徑");
    }
    throw error;
  }
}

export function migrateLegacyData(legacyDbPath: string, dbPath: string, avatarDir: string): void {
  if (legacyDbPath === dbPath || existsSync(dbPath) || !existsSync(legacyDbPath)) return;
  const directory = dirname(dbPath);
  const created = !existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created && process.platform !== "win32") chmodSync(directory, 0o700);
  const legacyAvatarDir = join(dirname(legacyDbPath), "avatars");
  let copiedAvatars = false;
  try {
    cpSync(legacyDbPath, dbPath, { errorOnExist: true });
    // A cleanly stopped SQLite database normally has no sidecars, but copying
    // an existing WAL/SHM pair preserves the latest committed state if present.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${legacyDbPath}${suffix}`)) cpSync(`${legacyDbPath}${suffix}`, `${dbPath}${suffix}`, { errorOnExist: true });
    }
    if (!existsSync(avatarDir) && existsSync(legacyAvatarDir)) {
      cpSync(legacyAvatarDir, avatarDir, { recursive: true, errorOnExist: true });
      copiedAvatars = true;
    }
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    if (copiedAvatars) rmSync(avatarDir, { recursive: true, force: true });
    throw error;
  }
}
