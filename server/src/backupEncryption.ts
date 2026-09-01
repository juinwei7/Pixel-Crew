import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("PCBK1", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ITERATIONS = 310_000;

function keyFor(password: string, salt: Buffer): Buffer {
  if (password.length < 12 || password.length > 1_024) throw new Error("Backup password must be 12–1024 characters");
  return pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
}

/** A small self-describing, authenticated wrapper around the existing tar.gz format. */
export function encryptBackup(data: Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(password, salt), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}

export function isEncryptedBackup(data: Buffer): boolean {
  return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptBackup(data: Buffer, password: string): Buffer {
  const headerLength = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (!isEncryptedBackup(data) || data.length <= headerLength) throw new Error("Not an encrypted Pixel Crew backup");
  const saltOffset = MAGIC.length;
  const ivOffset = saltOffset + SALT_BYTES;
  const tagOffset = ivOffset + IV_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", keyFor(password, data.subarray(saltOffset, ivOffset)), data.subarray(ivOffset, tagOffset));
  decipher.setAuthTag(data.subarray(tagOffset, headerLength));
  try { return Buffer.concat([decipher.update(data.subarray(headerLength)), decipher.final()]); }
  catch { throw new Error("Backup password is incorrect or the backup was modified"); }
}
