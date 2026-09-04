import type { Response } from "express";
import { join } from "node:path";
import { restoreFromSnapshot, snapshotCurrentData, swapInRestoredData, writeRestoreMarker } from "./backupImport.js";
import { t } from "./i18n.js";

export async function commitBackupRestore(input: {
  response: Response;
  importToken: unknown;
  confirmPhrase: unknown;
  pending: { stagingDir: string } | undefined;
  maintenance: boolean;
  setMaintenance(value: boolean): void;
  stopWorkers(): void;
  flush(): void;
  checkpoint(): void;
  closeStore(): void;
  discardPending(token: string): void;
  dataDirectory: string;
  dbPath: string;
  avatarDir: string;
  muxDbPath?: string;
  stopTerminalMux?(): Promise<void>;
  exit(code: number): void;
}): Promise<void> {
  const { response: res } = input;
  if (typeof input.importToken !== "string" || !input.pending) { res.status(410).json({ error: t("備份檢查已過期，請重新上傳") }); return; }
  if (input.confirmPhrase !== "RESTORE") { res.status(400).json({ error: t("確認文字不正確") }); return; }
  if (input.maintenance) { res.status(409).json({ error: t("已有還原正在進行") }); return; }

  input.setMaintenance(true);
  input.stopWorkers();
  const snapshotDir = join(input.dataDirectory, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  let exitCode = 0;
  let responseBody: { ok: boolean; message: string; preRestoreSnapshot?: string };
  try {
    input.flush(); input.checkpoint(); await input.stopTerminalMux?.(); input.closeStore();
    try {
      const paths = { dbPath: input.dbPath, avatarDir: input.avatarDir, muxDbPath: input.muxDbPath };
      snapshotCurrentData(paths, snapshotDir);
      try {
        swapInRestoredData(paths, input.pending.stagingDir);
        writeRestoreMarker(input.dataDirectory, { success: true, at: new Date().toISOString(), snapshotDir });
        responseBody = { ok: true, message: t("還原完成，請重新啟動 Pixel Crew"), preRestoreSnapshot: snapshotDir };
      } catch (swapError) {
        restoreFromSnapshot(paths, snapshotDir);
        writeRestoreMarker(input.dataDirectory, { success: false, at: new Date().toISOString(), message: (swapError as Error).message, snapshotDir });
        exitCode = 1;
        responseBody = { ok: false, message: t("還原失敗，已還原成原本的資料，請重新啟動 Pixel Crew 後再試一次") };
      }
    } catch (error) {
      writeRestoreMarker(input.dataDirectory, { success: false, at: new Date().toISOString(), message: (error as Error).message, snapshotDir: null });
      exitCode = 1;
      responseBody = { ok: false, message: t("還原失敗，請重新啟動 Pixel Crew 後再試一次") };
    }
  } finally { input.discardPending(input.importToken); }
  let exitScheduled = false;
  const scheduleExit = () => {
    if (exitScheduled) return;
    exitScheduled = true;
    setImmediate(() => input.exit(exitCode));
  };
  res.once("finish", scheduleExit);
  res.once("close", scheduleExit);
  res.status(exitCode === 0 ? 200 : 500).json(responseBody!);
}
