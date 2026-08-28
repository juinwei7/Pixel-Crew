/**
 * Approval policy for the opt-in auto-approve mode. A denylist alone cannot
 * safely classify shell or MCP actions, so automatic approval is based on a
 * narrow allowlist. The dangerous patterns below only improve the reason
 * shown when a known destructive command is rejected.
 */

import { t } from "./i18n.js";

export type DangerousMatch = { dangerous: boolean; reason?: string };
export type AutoApprovalMatch = { allowed: boolean; reason?: string };

// `rm` is a subcommand name for several wrapper tools (git rm, docker rm,
// npm/yarn/pnpm rm) that have nothing to do with the destructive shell `rm`.
// Excluding them here is what keeps auto-approve actually useful — without
// it, routine commands like `git rm -f old.txt` or `docker rm -f container`
// would always fall back to a manual prompt.
const NOT_A_WRAPPER_SUBCOMMAND = "(?<!\\b(?:git|docker|docker-compose|npm|yarn|pnpm)\\s)";
const RM_RECURSIVE_OR_FORCE = new RegExp(`${NOT_A_WRAPPER_SUBCOMMAND}\\brm\\b[^|&;\\n]*\\s(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\\b`, "i");
const RM_WITH_RISKY_TARGET = new RegExp(`${NOT_A_WRAPPER_SUBCOMMAND}\\brm\\b[^|&;\\n]*[^\\w.\\-\\/](\\/|~|\\$HOME|\\*|\\.\\.)(?:[\\s/]|$)`, "i");
const RM_BARE_ROOT_ISH = new RegExp(`${NOT_A_WRAPPER_SUBCOMMAND}\\brm\\b\\s+(-\\S+\\s+)*(\\/|~\\/?|\\*)\\s*$`, "i");
// Catches both the piped form (`curl x | bash`) and the download-then-run
// form connected by any command separator (`curl x -o f.sh && bash f.sh`,
// `curl x -o f.sh; bash f.sh`) — the same technique, just not chained with a
// literal pipe. Does not attempt to catch obfuscated payloads (base64/chr()
// reassembly, etc.); a denylist can only ever flag known shapes, not defeat
// arbitrary obfuscation.
const DOWNLOAD_THEN_EXECUTE = /\b(curl|wget)\b[\s\S]*?(?:\||&&|;|\n)\s*(sudo\s+)?\b(sh|bash|zsh|python3?|perl|ruby|node)\b/i;

const PATTERNS: Array<{ test: RegExp; reason: string }> = [
  { test: RM_RECURSIVE_OR_FORCE, reason: "遞迴或強制刪除（rm -r / -f）" },
  { test: RM_WITH_RISKY_TARGET, reason: "刪除目標包含根目錄、家目錄、萬用字元或上層目錄" },
  { test: RM_BARE_ROOT_ISH, reason: "刪除目標是根目錄、家目錄或萬用字元" },
  { test: /\bsudo\b/i, reason: "使用 sudo 提升權限" },
  { test: /\bmkfs(\.\w+)?\b/i, reason: "格式化磁區（mkfs）" },
  { test: /\bdd\b[^|&;\n]*\b(if|of)=\/dev\//i, reason: "直接讀寫裝置檔（dd ...=/dev/...）" },
  { test: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "直接寫入裝置檔" },
  { test: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "關機或重新啟動系統" },
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/, reason: "fork bomb" },
  { test: /\bchmod\b[^|&;\n]*(-R|--recursive)[^|&;\n]*\b777\b/i, reason: "遞迴開放所有權限（chmod -R 777）" },
  { test: DOWNLOAD_THEN_EXECUTE, reason: "下載並直接執行遠端指令" },
  { test: /\bgit\s+push\b[^|&;\n]*(--force\b|(?<!--)\s-f\b)/i, reason: "強制推送（git push --force）覆蓋遠端歷史" },
  { test: /\bgit\s+reset\b[^|&;\n]*--hard\b/i, reason: "硬重置（git reset --hard）可能捨棄未提交的變更" },
];

export function isDangerousCommand(command: string): DangerousMatch {
  const normalized = command.trim();
  if (!normalized) return { dangerous: false };
  for (const { test, reason } of PATTERNS) {
    // PATTERNS 是模組載入期建好的常數陣列；reason 在這裡（呼叫當下）才過 t()，
    // 才能吃到當下語言設定——陣列本身刻意保留原文，不在載入期先算好英譯。
    if (test.test(normalized)) return { dangerous: true, reason: t(reason) };
  }
  return { dangerous: false };
}

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
const SHELL_META = /[\r\n;&|<>`]|\$[({]/;
const SAFE_BASH_COMMANDS = [
  /^(pwd|ls|cat|head|tail|wc|echo|printf)(?:\s|$)/,
  /^(rg|grep)(?:\s|$)/,
  /^sed\s+-n(?:\s|$)/,
  /^git\s+(status|diff|log|show)(?:\s|$)/,
  /^(npm|pnpm)\s+test(?:\s|$)/,
  /^(npm|pnpm)\s+run\s+(test|build|check|lint|typecheck)(?:\s|$)/,
  /^yarn\s+(test|build|check|lint|typecheck)(?:\s|$)/,
  /^(tsc|eslint)(?:\s|$)/,
];

// 串接指令逐段放行：每一段都在唯讀白名單內才整條自動核准。
// 只容忍「丟棄輸出」類重導向（2>&1、2>/dev/null）；任何寫檔重導向、指令替換
// （$()、反引號）、背景執行（&）一律不放行，維持「嚴格放寬」——放過的仍然全是唯讀。
function isSafeCompoundCommand(normalized: string): boolean {
  const stripped = normalized
    .replace(/\d?>\s*&\s*\d/g, " ")
    .replace(/\d?>{1,2}\s*\/dev\/null/g, " ");
  if (/[`<>]|\$[({]/.test(stripped)) return false;
  const segments = stripped.split(/\r?\n|&&|\|\||;|\|/);
  if (segments.some((segment) => segment.includes("&"))) return false;
  const parts = segments.map((segment) => segment.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => SAFE_BASH_COMMANDS.some((pattern) => pattern.test(part)));
}

export function autoApprovalPolicy(toolName: string, command?: string): AutoApprovalMatch {
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
  if (toolName !== "Bash") {
    return { allowed: false, reason: t("{tool} 可能修改本機或外部資料", { tool: toolName }) };
  }
  const normalized = command?.trim() ?? "";
  if (!normalized) return { allowed: false, reason: t("無法辨識指令內容") };
  const danger = isDangerousCommand(normalized);
  if (danger.dangerous) return { allowed: false, reason: danger.reason };
  if (SHELL_META.test(normalized)) {
    if (isSafeCompoundCommand(normalized)) return { allowed: true };
    return { allowed: false, reason: t("串接中含寫入型重導向、替換語法或不在唯讀清單的片段") };
  }
  if (SAFE_BASH_COMMANDS.some((pattern) => pattern.test(normalized))) return { allowed: true };
  return { allowed: false, reason: t("指令不在唯讀／驗證安全清單") };
}

/**
 * "safe" only lets through a narrow, curated allowlist (autoApprovalPolicy) —
 * it still asks for anything it doesn't specifically recognize, which is
 * correct-but-conservative. "full" flips the default to allow: everything
 * auto-approves except Bash commands matched by the isDangerousCommand
 * denylist, so day-to-day work (git rm, docker rm, arbitrary npm scripts, …)
 * stops prompting, while the well-known catastrophic shell patterns still do.
 *
 * IMPORTANT: in "full" mode, every non-Bash tool call — including every tool
 * on every connected MCP server — is allowed unconditionally (see the
 * `toolName !== "Bash"` branch below). There is no per-tool risk
 * classification for MCP tools, so "full" genuinely means "never ask again
 * for anything an MCP server can do," not just "be lenient about shell
 * commands." Reflect this in any UI copy describing the mode.
 */
// "invincible"（無敵）：使用者明確要求的第四檔——完全不設限、永不詢問，連 isDangerousCommand
// 命中的毀滅性指令（rm -rf、sudo、mkfs…）都直接放行。等同 Claude Code 的
// --dangerously-skip-permissions。風險自負，UI 文案必須把話講明。
export type { AutoApproveMode } from "./protocol.js";
import type { AutoApproveMode } from "./protocol.js";

export function evaluateAutoApproval(mode: AutoApproveMode, toolName: string, command?: string): AutoApprovalMatch {
  if (mode === "invincible") return { allowed: true };
  if (mode === "off") return { allowed: false };
  if (mode === "safe") return autoApprovalPolicy(toolName, command);
  if (toolName !== "Bash") return { allowed: true };
  const danger = isDangerousCommand(command?.trim() ?? "");
  return danger.dangerous ? { allowed: false, reason: danger.reason } : { allowed: true };
}
