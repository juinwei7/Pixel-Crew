import { lstatSync } from "node:fs";
import { join } from "node:path";

const MAX_OUTBOX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 成品匣單檔取用的「守門」決策，抽成純函式以便回歸測試（見外傳風險盤點 §七 通道 F）。
 * 只做安全判定，不碰 HTTP 呈現：
 *  - 檔名只允許純檔名（擋路徑穿越 `/` `\` `..`）→ 400
 *  - lstat（不跟隨連結）+ 顯式擋符號連結：NPC 能在 outbox/ 內建立指向 workspace 外機密檔的
 *    symlink，statSync 會跟隨並把外部檔案送出。擋在讀取前，回 404 不洩漏連結是否存在 → 404
 *  - 非一般檔（目錄等）→ 404；過大 → 413
 * 呼叫端（index.ts 路由）負責把狀態碼對應成訊息與內容型別、附件處置。
 */
export type OutboxFileResolution =
  | { ok: true; fullPath: string; size: number }
  | { ok: false; status: 400 | 404 | 413 };

export function resolveOutboxFile(workspacePath: string, name: string): OutboxFileResolution {
  if (!name || /[\\/]/.test(name) || name.includes("..")) return { ok: false, status: 400 };
  const full = join(workspacePath, "outbox", name);
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(full); } catch { return { ok: false, status: 404 }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, status: 404 };
  if (st.size > MAX_OUTBOX_FILE_BYTES) return { ok: false, status: 413 };
  return { ok: true, fullPath: full, size: st.size };
}
