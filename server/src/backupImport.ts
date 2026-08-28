import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { AVATAR_ID, validateGif, validatePng } from "./avatarStore.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import { t } from "./i18n.js";

export class BackupValidationError extends Error {}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");
const RESTORE_MARKER_NAME = ".last-restore-result.json";
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;

export type BackupSummary = {
  exportedAt: string | null;
  appVersion: string | null;
  workerCount: number;
  avatarCount: number;
  warnings: string[];
};

function readMagicHeader(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SQLITE_MAGIC.length);
    readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

// Extracts an uploaded backup archive into an isolated staging directory and
// fully validates it there, WITHOUT touching any live data. Throws
// BackupValidationError on anything that should block the restore outright;
// non-fatal issues (a corrupted avatar) are dropped and reported as warnings.
export async function extractAndValidateBackup(tarGzPath: string, stagingDir: string): Promise<BackupSummary> {
  ensurePrivateDirectorySync(stagingDir);
  let rejected: string | null = null;
  let entryCount = 0;
  let extractedBytes = 0;
  await tar.extract({
    file: tarGzPath,
    cwd: stagingDir,
    strict: true,
    filter: (entryPath, entry) => {
      if (rejected) return false;
      entryCount++;
      extractedBytes += Number(entry.size) || 0;
      if (entryCount > MAX_ARCHIVE_ENTRIES || extractedBytes > MAX_EXTRACTED_BYTES) {
        rejected = t("備份檔案解壓後過大或包含過多項目");
        return false;
      }
      // A tar entry can itself be typed as a symlink/hardlink — `tar`'s own
      // path-traversal defenses don't cover this: our own code later
      // renames/copies through the staged tree, so a symlink entry is a
      // distinct escape vector once that happens.
      if ("type" in entry && (entry.type === "SymbolicLink" || entry.type === "Link")) {
        rejected = t("不允許的檔案類型：{path}", { path: entryPath });
        return false;
      }
      const resolved = join(stagingDir, entryPath);
      const rel = relative(stagingDir, resolved);
      if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
        rejected = t("不安全的路徑：{path}", { path: entryPath });
        return false;
      }

      // Extract only the fixed backup layout. Besides reducing the attack
      // surface, this prevents a compressed archive full of unrelated files
      // from consuming disk before the manifest/database checks run.
      const normalized = entryPath.replace(/^\.\//, "").replace(/\/+$/, "");
      const isDirectory = "type" in entry && entry.type === "Directory";
      const allowedDirectory = normalized === "db" || normalized === "avatars";
      const allowedFile = normalized === "manifest.json"
        || /^db\/cockpit\.sqlite(?:-(?:wal|shm))?$/.test(normalized)
        || /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|gif)$/i.test(normalized);
      if ((isDirectory && !allowedDirectory) || (!isDirectory && !allowedFile)) {
        rejected = t("備份檔案包含未知項目：{path}", { path: entryPath });
        return false;
      }
      return true;
    },
  });
  if (rejected) throw new BackupValidationError(rejected);

  let manifest: { formatVersion?: unknown; exportedAt?: unknown; appVersion?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(stagingDir, "manifest.json"), "utf8"));
  } catch {
    throw new BackupValidationError(t("不是有效的 Pixel Crew 備份檔案"));
  }
  if (manifest.formatVersion !== 1) {
    throw new BackupValidationError(t("備份檔案版本不受支援，請使用相容版本的 Pixel Crew 匯出"));
  }

  const dbPath = join(stagingDir, "db", "cockpit.sqlite");
  if (!existsSync(dbPath)) throw new BackupValidationError(t("備份檔案缺少資料庫"));
  if (!readMagicHeader(dbPath).equals(SQLITE_MAGIC)) {
    throw new BackupValidationError(t("資料庫檔案格式無效"));
  }

  let workerCount = 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new BackupValidationError(t("資料庫完整性檢查失敗，此備份檔案可能已損毀"));
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workers','runner_events')")
      .all() as Array<{ name: string }>;
    if (tables.length !== 2) throw new BackupValidationError(t("資料庫缺少必要的資料表"));
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM workers").get() as { count?: number } | undefined;
    workerCount = countRow?.count ?? 0;
  } finally {
    db.close();
  }

  const warnings: string[] = [];
  const avatarsDir = join(stagingDir, "avatars");
  let avatarCount = 0;
  if (existsSync(avatarsDir)) {
    let skipped = 0;
    for (const fileName of readdirSync(avatarsDir)) {
      const filePath = join(avatarsDir, fileName);
      if (!AVATAR_ID.test(fileName)) {
        rmSync(filePath, { force: true });
        skipped++;
        continue;
      }
      try {
        const data = readFileSync(filePath);
        if (fileName.toLowerCase().endsWith(".gif")) validateGif(data);
        else validatePng(data);
        avatarCount++;
      } catch {
        rmSync(filePath, { force: true });
        skipped++;
      }
    }
    if (skipped > 0) warnings.push(t("已略過 {n} 個角色圖片（驗證失敗）", { n: skipped }));
  }

  return {
    exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : null,
    appVersion: typeof manifest.appVersion === "string" ? manifest.appVersion : null,
    workerCount,
    avatarCount,
    warnings,
  };
}

function moveOrCopy(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Cross-device (AVATAR_DIR/DB_PATH can be independently overridden to a
    // different volume) — fall back to copy-then-remove.
    cpSync(src, dest, { recursive: true, errorOnExist: true });
    rmSync(src, { recursive: true, force: true });
  }
}

type DataPaths = { dbPath: string; avatarDir: string };

// Moves the current live DB (+ sidecars, if any) and avatars directory out
// of the way into `snapshotDir`, kept on disk as a safety net even after a
// successful restore (the caller decides whether/when to clean it up).
export function snapshotCurrentData(paths: DataPaths, snapshotDir: string): void {
  ensurePrivateDirectorySync(snapshotDir);
  const dbDir = join(snapshotDir, "db");
  ensurePrivateDirectorySync(dbDir);
  if (existsSync(paths.dbPath)) moveOrCopy(paths.dbPath, join(dbDir, "cockpit.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${paths.dbPath}${suffix}`)) moveOrCopy(`${paths.dbPath}${suffix}`, join(dbDir, `cockpit.sqlite${suffix}`));
  }
  if (existsSync(paths.avatarDir)) moveOrCopy(paths.avatarDir, join(snapshotDir, "avatars"));
}

// Moves the validated staged backup contents into the live dbPath/avatarDir
// locations. Must only be called after snapshotCurrentData has cleared them.
export function swapInRestoredData(paths: DataPaths, stagingDir: string): void {
  const stagedDb = join(stagingDir, "db", "cockpit.sqlite");
  moveOrCopy(stagedDb, paths.dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const stagedSidecar = join(stagingDir, "db", `cockpit.sqlite${suffix}`);
    if (existsSync(stagedSidecar)) moveOrCopy(stagedSidecar, `${paths.dbPath}${suffix}`);
  }
  const stagedAvatars = join(stagingDir, "avatars");
  if (existsSync(stagedAvatars)) moveOrCopy(stagedAvatars, paths.avatarDir);
}

// Reverses snapshotCurrentData: clears whatever partial state a failed swap
// may have left behind at dbPath/avatarDir, then moves the snapshot back.
export function restoreFromSnapshot(paths: DataPaths, snapshotDir: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${paths.dbPath}${suffix}`, { force: true });
  rmSync(paths.avatarDir, { recursive: true, force: true });
  const dbDir = join(snapshotDir, "db");
  const snapshotDb = join(dbDir, "cockpit.sqlite");
  if (existsSync(snapshotDb)) moveOrCopy(snapshotDb, paths.dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const snapshotSidecar = join(dbDir, `cockpit.sqlite${suffix}`);
    if (existsSync(snapshotSidecar)) moveOrCopy(snapshotSidecar, `${paths.dbPath}${suffix}`);
  }
  const snapshotAvatars = join(snapshotDir, "avatars");
  if (existsSync(snapshotAvatars)) moveOrCopy(snapshotAvatars, paths.avatarDir);
}

export type RestoreMarker = {
  success: boolean;
  at: string;
  snapshotDir: string | null;
  message?: string;
};

// Written just before the server exits at the end of a restore attempt, so
// the outcome survives even if the HTTP response itself is lost to the
// process-exit race. Read (and cleared) once on the next startup.
export function writeRestoreMarker(dataDirectory: string, marker: RestoreMarker): void {
  const path = join(dataDirectory, RESTORE_MARKER_NAME);
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  protectFileSync(path);
}

export function readAndClearRestoreMarker(dataDirectory: string): RestoreMarker | null {
  const path = join(dataDirectory, RESTORE_MARKER_NAME);
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as RestoreMarker;
    return marker;
  } catch {
    return null;
  } finally {
    rmSync(path, { force: true });
  }
}
