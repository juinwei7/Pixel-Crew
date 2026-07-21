import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";
import { readCurrentVersion } from "./updateCheck.js";

export const BACKUP_FORMAT_VERSION = 1;

export type BackupManifest = {
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
};

// Stages a copy of the DB (+ WAL/SHM sidecars, if present) and the avatars
// directory into a fixed internal layout, decoupled from the exporting
// machine's actual dbPath/avatarDir (which may live on different volumes —
// see config.ts). Import always writes back to whatever dbPath/avatarDir are
// configured on the *importing* machine, never to a name embedded here.
// Mirrors platform/paths.ts's migrateLegacyData() copy technique.
export function stageExportDirectory(
  paths: { dbPath: string; avatarDir: string },
  stagingDir: string,
): void {
  ensurePrivateDirectorySync(stagingDir);
  const dbDir = join(stagingDir, "db");
  ensurePrivateDirectorySync(dbDir);
  cpSync(paths.dbPath, join(dbDir, "cockpit.sqlite"), { errorOnExist: true });
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${paths.dbPath}${suffix}`)) {
      cpSync(`${paths.dbPath}${suffix}`, join(dbDir, `cockpit.sqlite${suffix}`), { errorOnExist: true });
    }
  }
  const avatarsDir = join(stagingDir, "avatars");
  if (existsSync(paths.avatarDir)) cpSync(paths.avatarDir, avatarsDir, { recursive: true, errorOnExist: true });
  else ensurePrivateDirectorySync(avatarsDir); // never-uploaded-an-avatar case — archive still has a stable shape.
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: readCurrentVersion(),
  };
  writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
