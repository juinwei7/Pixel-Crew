import assert from "node:assert/strict";
import test from "node:test";
import { decryptBackup, encryptBackup, isEncryptedBackup } from "../src/backupEncryption.js";

test("encrypted backups authenticate their content and require the original password", () => {
  const original = Buffer.from("a normal tar.gz payload", "utf8");
  const encrypted = encryptBackup(original, "a-long-backup-password");
  assert.ok(isEncryptedBackup(encrypted));
  assert.deepEqual(decryptBackup(encrypted, "a-long-backup-password"), original);
  assert.throws(() => decryptBackup(encrypted, "wrong-long-password"), /incorrect|modified/);
  encrypted[encrypted.length - 1] ^= 0xff;
  assert.throws(() => decryptBackup(encrypted, "a-long-backup-password"), /incorrect|modified/);
});
