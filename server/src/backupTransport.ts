import type { Response } from "express";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";
import { encryptBackup } from "./backupEncryption.js";
import { stageExportDirectory } from "./backupExport.js";
import { t } from "./i18n.js";

export async function writeBackupExport(input: {
  response: Response;
  dataDirectory: string;
  dbPath: string;
  avatarDir: string;
  muxDbPath?: string;
  id: string;
  password?: string;
  flush(): void;
  checkpoint(): void;
}): Promise<void> {
  const { response: res, password } = input;
  const stagingDir = join(input.dataDirectory, `.export-${input.id}`);
  try {
    input.flush();
    input.checkpoint();
    stageExportDirectory({ dbPath: input.dbPath, avatarDir: input.avatarDir, muxDbPath: input.muxDbPath }, stagingDir);
    const date = new Date().toISOString().slice(0, 10);
    if (password) {
      const archivePath = join(stagingDir, "backup.tar.gz");
      await tar.create({ gzip: true, cwd: stagingDir, portable: true, file: archivePath } as any, ["manifest.json", "db", "avatars", "mux"]);
      res.set({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="pixel-crew-backup-${date}.pcbak"`,
        "X-Content-Type-Options": "nosniff",
      }).send(encryptBackup(readFileSync(archivePath), password));
      rmSync(stagingDir, { recursive: true, force: true });
      return;
    }
    res.set({
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="pixel-crew-backup-${date}.tar.gz"`,
      "X-Content-Type-Options": "nosniff",
    });
    const stream = tar.create({ gzip: true, cwd: stagingDir, portable: true } as any, ["manifest.json", "db", "avatars", "mux"]);
    stream.on("error", (error: unknown) => { console.warn("Backup export stream failed:", (error as Error).message); res.destroy(error as Error); });
    res.on("close", () => rmSync(stagingDir, { recursive: true, force: true }));
    (stream as unknown as NodeJS.ReadableStream).pipe(res);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    console.warn("Backup export failed:", (error as Error).message);
    if (!res.headersSent) res.status(500).json({ error: t("無法建立備份檔案") }); else res.destroy();
  }
}
