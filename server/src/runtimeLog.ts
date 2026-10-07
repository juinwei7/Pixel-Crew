import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MAX_DETAIL_LENGTH = 2_000;

function cleanDetail(value: unknown): string {
  // 物件要 JSON 序列化，否則 String(obj) 會變成無資訊的 "[object Object]"。
  let s: string;
  if (value != null && typeof value === "object") {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  } else {
    s = String(value ?? "");
  }
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .slice(0, MAX_DETAIL_LENGTH);
}

export function runtimeLogPath(dataDirectory: string): string {
  return join(dataDirectory, "runtime.log");
}

/** Keep a small local trail for failures that otherwise vanish with a dev watcher. */
export function appendRuntimeLog(dataDirectory: string, event: string, detail?: unknown): void {
  try {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const suffix = detail == null || detail === "" ? "" : ` | ${cleanDetail(detail)}`;
    const path = runtimeLogPath(dataDirectory);
    appendFileSync(path, `${new Date().toISOString()} ${event}${suffix}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Runtime logging must never be able to take the local service down.
  }
}
