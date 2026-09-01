import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import multer from "multer";
import { decryptBackup, isEncryptedBackup } from "./backupEncryption.js";
import { BackupValidationError, extractAndValidateBackup } from "./backupImport.js";
import { t } from "./i18n.js";
import { ensurePrivateDirectorySync } from "./platform/fileProtection.js";

export function registerBackupImportTransport(input: {
  app: Express;
  dataDirectory: string;
  createPending(stagingDir: string): string;
  discardPending(token: string): void;
}): void {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        try {
          const directory = join(input.dataDirectory, `.import-upload-${randomUUID()}`);
          ensurePrivateDirectorySync(directory);
          callback(null, directory);
        } catch (error) { callback(error as Error, ""); }
      },
      filename: (_req, _file, callback) => callback(null, "upload.tar.gz"),
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
  });

  input.app.post("/api/backup/import/validate", upload.single("backup"), async (req, res) => {
    if (!req.file) { res.status(400).json({ error: t("缺少備份檔案") }); return; }
    const uploadDir = dirname(req.file.path);
    const stagingDir = join(input.dataDirectory, `.import-staged-${randomUUID()}`);
    try {
      const uploaded = readFileSync(req.file.path);
      let archivePath = req.file.path;
      if (isEncryptedBackup(uploaded)) {
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        if (!password) throw new BackupValidationError(t("此備份已加密；請輸入密碼"));
        archivePath = join(uploadDir, "decrypted.tar.gz");
        try { writeFileSync(archivePath, decryptBackup(uploaded, password), { mode: 0o600 }); }
        catch { throw new BackupValidationError(t("備份密碼不正確或檔案已損毀")); }
      }
      const result = await extractAndValidateBackup(archivePath, stagingDir);
      res.json({ importToken: input.createPending(stagingDir), ...result });
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      res.status(400).json({ error: error instanceof BackupValidationError ? error.message : t("備份檔案驗證失敗") });
    } finally { rmSync(uploadDir, { recursive: true, force: true }); }
  });

  input.app.delete("/api/backup/import/:token", (req, res) => {
    input.discardPending(req.params.token);
    res.status(204).end();
  });
}
