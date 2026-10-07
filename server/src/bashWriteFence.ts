import { homedir } from "node:os";
import { join } from "node:path";
import { pathEscapesWorkspace } from "./safeLocalPath.js";

/**
 * 通道 E 的 Bash 對稱補強（見外傳風險盤點 §九）。
 *
 * E 圍欄靠結構化 file_path 判定，Bash 沒有結構化路徑，故此處只做一件**可靠**的事：
 * 掃出「寫入型重導向」（`>` / `>>` 及其 fd、`&>`、`>|` 變形）的字面目標路徑，若逃逸出 workspace 就回 true 讓核准橋硬擋。
 *
 * **刻意不做完整 shell 解析**（那是無底洞且仍不可靠）——本函式只認字面重導向目標，
 * 對變數展開（`p=/etc; echo>$p`，家目錄 `~`／`$HOME` 除外）、子殼、直譯器（python -c open()）、cp/mv/tee 目的地等
 * 一律「認不出＝不擋」。因此這是**防禦縱深、非圍牆**，與 denylist 同哲學（只擋已知形狀）。
 * 殘餘繞過與 owner 選項見 §九。零 shell 執行、純字串＋路徑正規化，無副作用。
 */
export function bashRedirectsOutsideWorkspace(workspacePath: string, command: string): boolean {
  if (!command) return false;
  // 寫入型重導向：`>`、`>>`，帶 fd 的 `1>`、`2>>`，`&>`／`&>>`（stdout+stderr 一起寫），強制覆寫的
  // `>|`（zsh 也認 `>!`），以及目標不是 fd 編號的 `>&file`。`2>&1`、`>&2`、`>&-` 這類 fd 複製／關閉
  // 不是寫檔，下面依目標排除。
  const redir = /(&>>?|\d*>>?[|!]?&?)\s*("[^"]*"|'[^']*'|[^\s"'|&;<>()]+)/g;
  for (const match of command.matchAll(redir)) {
    const operator = match[1];
    let target = match[2];
    const quote = target[0] === '"' || target[0] === "'" ? target[0] : "";
    if (quote && target.endsWith(quote)) target = target.slice(1, -1);
    if (!target) continue;
    if (operator.endsWith("&") && /^(\d+|-)$/.test(target)) continue;
    // 丟棄輸出的慣用目標不算外傳。
    if (/^\/dev\/(null|stdout|stderr)$/i.test(target)) continue;
    // shell 會先展開家目錄：`~`（只在沒加引號時）與 `$HOME`（單引號內不展開）。`~user`、`~+` 這類
    // 無法靜態判定，一律當成逃逸。
    if (!quote && /^~(?=$|[\\/])/.test(target)) target = join(homedir(), target.slice(1));
    else if (!quote && target.startsWith("~")) return true;
    else if (quote !== "'" && /^\$(HOME|\{HOME\})(?=$|[\\/])/.test(target)) target = join(homedir(), target.replace(/^\$(HOME|\{HOME\})/, ""));
    if (pathEscapesWorkspace(workspacePath, target)) return true;
  }
  return false;
}
