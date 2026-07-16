import { chmod, mkdir } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync } from "node:fs";

export function ensurePrivateDirectorySync(path: string): void {
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (created && process.platform !== "win32") chmodSync(path, 0o700);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const created = !existsSync(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (created && process.platform !== "win32") await chmod(path, 0o700);
}

export function protectFileSync(path: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export async function protectFile(path: string): Promise<void> {
  if (process.platform !== "win32") await chmod(path, 0o600);
}
