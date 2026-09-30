import { pathEscapesWorkspace } from "./safeLocalPath.js";

/**
 * 通道 E 的 Bash 對稱補強（見外傳風險盤點 §九）。
 *
 * E 圍欄靠結構化 file_path 判定，Bash 沒有結構化路徑，故此處只做一件**可靠**的事：
 * 掃出「寫入型重導向」（`>` / `>>`）的字面目標路徑，若逃逸出 workspace 就回 true 讓核准橋硬擋。
 *
 * **刻意不做完整 shell 解析**（那是無底洞且仍不可靠）——本函式只認字面重導向目標，
 * 對變數展開（`p=/etc; echo>$p`）、子殼、直譯器（python -c open()）、cp/mv/tee 目的地等
 * 一律「認不出＝不擋」。因此這是**防禦縱深、非圍牆**，與 denylist 同哲學（只擋已知形狀）。
 * 殘餘繞過與 owner 選項見 §九。零 shell 執行、純字串＋路徑正規化，無副作用。
 */
export function bashRedirectsOutsideWorkspace(workspacePath: string, command: string): boolean {
  if (!command) return false;
  // `>` 或 `>>`，但排除 fd 形式：前有數字（2>、1>）或 &（&>）、後接 &（>&2）皆非寫檔到路徑。
  const redir = /(?<![\d&])>{1,2}(?!&)\s*("[^"]*"|'[^']*'|[^\s"'|&;<>()]+)/g;
  for (const match of command.matchAll(redir)) {
    let target = match[1];
    if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1);
    }
    if (!target) continue;
    // 丟棄輸出的慣用目標不算外傳。
    if (/^\/dev\/(null|stdout|stderr)$/i.test(target)) continue;
    if (pathEscapesWorkspace(workspacePath, target)) return true;
  }
  return false;
}
