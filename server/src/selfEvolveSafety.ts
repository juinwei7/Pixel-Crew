// 自我進化引擎的安全網不變量（階段 2）。
//
// 鐵律：一個會改自己、還能自己冷安裝的系統，絕不准自動放寬／拆掉自己的「剎車」——
// 否則一個壞改動可以先關掉會擋住下一個壞改動的檢查，自我改進就變自我毀滅。
//
// 這支純函式判斷「一組自改」有沒有動到保護機制。動到＝critical＝自我進化引擎必須回到 owner
// 拍板（帶好建議、一鍵可答），不得走自動冷安裝那條路。其餘非 critical 的改動才可在閘門全綠後自裝。
// 判準刻意保守（寧可多攔、要 owner 看一眼），因為漏放一個削弱剎車的改動，代價不可逆。

export type SelfChangeHit = { file: string; reason: string };
export type SelfChangeClassification = {
  critical: boolean;
  hits: SelfChangeHit[];
};

// 保護機制「所在的檔」——改到任一個，一律 critical（不看內容）。
const SAFETY_CRITICAL_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[\\/])toolPolicy\.ts$/i, reason: "唯讀查詢工具白名單（探索唯讀圍欄）" },
  { pattern: /(^|[\\/])dangerousCommand\.ts$/i, reason: "危險指令／唯讀安全 Bash 分類器" },
  { pattern: /(^|[\\/])bashWriteFence\.ts$/i, reason: "Bash 寫檔逃逸柵欄（通道 E）" },
  { pattern: /(^|[\\/])selfEvolveSafety\.ts$/i, reason: "安全網不變量本身（不准自己放寬自己）" },
  { pattern: /(^|[\\/])coldinstall([\\/]|$)/i, reason: "冷安裝／回滾產物" },
  { pattern: /pc-coldinstall/i, reason: "冷安裝腳本" },
  { pattern: /package-app\.mjs$/i, reason: "打包／冷安裝流程" },
  // 閘門的「呼叫端」跟閘門本身一樣是剎車：改掉範圍判斷、開機晉升或重建腳本裡的 build/test
  // 步驟，等於繞過上面所有規則，而這些改動的增刪行未必剛好含剎車關鍵字，所以整檔封鎖。
  { pattern: /(^|[\\/])selfEvolveInstall\.ts$/i, reason: "自裝閘門與比對範圍判斷" },
  { pattern: /(^|[\\/])selfEvolvePending\.ts$/i, reason: "開機晉升／回滾判斷" },
  { pattern: /(^|[\\/])selfInstallLifecycle\.ts$/i, reason: "回滾點生命週期" },
  { pattern: /(^|[\\/])selfInstallTrigger\.ts$/i, reason: "自裝觸發器（閘門接線）" },
  { pattern: /pc-selfrebuild/i, reason: "自我重建腳本（build/test 全綠才出貨）" },
  { pattern: /pc-selfinstall/i, reason: "自我安裝腳本（健康檢查＋自動回滾）" },
  { pattern: /(^|[\\/])localAccess\.ts$/i, reason: "本機存取白名單（loopback 安全邊界）" },
  { pattern: /(^|[\\/])_tsproxy\.mjs$/i, reason: "遠端存取轉接站（登入與分享權限）" },
];

// 這些檔是進化引擎會合法演進的（例如循環邏輯、主程式），不整檔封鎖；但若 diff 觸及其中的
// 「剎車規則」關鍵字（STOP 條件／授權同意／唯讀圍欄開關／回滾／閘門），仍一律 critical。
// 用內容面關鍵字，而非整檔，才能讓引擎繼續進化非安全部分、又擋住偷改剎車。
const SAFETY_RULE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /NEVER PRESUME CONSENT/i, reason: "改動『花錢/不可逆不假設同意』規則" },
  { pattern: /allowSafeShell/i, reason: "改動唯讀安全 Bash 放行旗標" },
  { pattern: /queryToolPolicy|autoApprovalPolicy|evaluateAutoApproval/i, reason: "改動工具核准／唯讀分類判斷" },
  { pattern: /read_only_query|queryAllowedTools/i, reason: "改動唯讀查詢回合的工具邊界" },
  { pattern: /pathEscapesWorkspace|bashRedirectsOutsideWorkspace/i, reason: "改動工作區外寫入／外傳柵欄" },
  { pattern: /\brollback\b|回滾/i, reason: "改動冷安裝回滾機制" },
  { pattern: /STOP only for what you genuinely cannot settle|money.{0,4}irreversible|不可逆/i, reason: "改動循環 STOP／花錢不可逆守則" },
  { pattern: /four[\s-]?件套|四件套|SWAPPED OK/i, reason: "改動冷安裝自驗四件套" },
  { pattern: /SelfInstall|self-install|SELF_REPO/, reason: "改動自裝觸發器／開機晉升接線" },
];

function norm(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

// 只掃真正改動的行（+ 新增／- 刪除），不掃 unified diff 的上下文行：上下文是沒動的舊碼，
// 例如某行舊註解剛好寫著「失敗回滾」，會讓純前端改動被誤判成動到剎車。刪掉剎車規則一定
// 出現在 - 行、偷加一定出現在 + 行，所以這樣不會放過任何真的改動。
// 不像 unified diff（沒有 diff --git／@@ 標頭）的輸入維持整段掃，寧可多攔。
function changedDiffLines(diffText: string): string {
  const lines = diffText.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith("@@") || line.startsWith("diff --git"))) return diffText;
  return lines
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++ ")) || (line.startsWith("-") && !line.startsWith("--- ")))
    .join("\n");
}

// 純文件檔：diff 內容不參與剎車關鍵字比對（只看上面的檔名規則）。2026-10 實際誤擋：4135377 只改
// README/CHANGELOG/scripts，但 README 內文「說明」了循環 STOP／不可逆守則，就被當成改剎車擋下。
// 文件不會被裝進 app 執行，描述剎車≠改剎車。程式檔(.ts/.js/.ps1/.mjs…)的內容比對完全不變。
// 例外（仍照掃內容）：會被代理當成「指令」讀進去的 .md——CLAUDE.md/AGENTS.md/SKILL.md 這類、以及
// .claude/、.codex/、prompts/、skills/、commands/、agents/ 底下的檔，改它們等於改代理行為，寧可多攔。
const PURE_DOC_EXT = /\.(md|mdx|markdown|rst|adoc)$/i;
const AGENT_INSTRUCTION_DOC =
  /(^|\/)(CLAUDE|AGENTS|GEMINI|SKILL|COPILOT-INSTRUCTIONS)\.md$|(^|\/)\.(claude|codex|cursor|gemini)\/|(^|\/)(prompts?|skills|commands|agents)\//i;

/** 是否為「純文件檔」（diff 內容不做剎車關鍵字比對，只看檔名規則）。 */
export function isPureDocFile(file: string): boolean {
  const f = norm(typeof file === "string" ? file : "");
  if (!f) return false;
  return PURE_DOC_EXT.test(f) && !AGENT_INSTRUCTION_DOC.test(f);
}

// 從 `diff --git a/X b/Y` 標頭取出兩側路徑（含 git 對特殊字元加引號的形式）。解析失敗回 null
// ＝不認得＝不豁免（保守）。
function diffHeaderPaths(line: string): string[] | null {
  // 檔名含空白且未加引號時切點有歧義：先試「左右對稱」（非改名的常態），再試以 " b/" 切，最後才通用切法。
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith('"') && rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === " " && a.replace(/^[^/]*\//, "") === b.replace(/^[^/]*\//, "")) return [a, b];
  }
  const m =
    /^diff --git (?:"((?:[^"\\]|\\.)*)"|(\S.*?)) (?:"((?:[^"\\]|\\.)*)"|(b\/.*))$/.exec(line) ??
    /^diff --git (?:"((?:[^"\\]|\\.)*)"|(\S.*?)) (?:"((?:[^"\\]|\\.)*)"|([^\s"].*))$/.exec(line);
  if (!m) return null;
  const a = m[1] ?? m[2];
  const b = m[3] ?? m[4];
  if (!a || !b) return null;
  return [a, b];
}

/**
 * 把 unified diff 裡「純文件檔」那幾段整段拿掉（含其 +/- 行），其餘原樣保留。改名時兩側都得是
 * 純文件才拿掉（.ts 改名成 .md 不豁免）。檔案內容行一定帶 +/-/空白 前綴，無法偽造 diff --git 標頭。
 * 不像 unified diff（沒有 diff --git 標頭）的輸入原樣回傳＝整段照掃。
 */
export function stripDocOnlyDiffSections(diffText: string): string {
  const lines = diffText.split(/\r?\n/);
  if (!lines.some((line) => line.startsWith("diff --git "))) return diffText;
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const paths = diffHeaderPaths(line);
      skipping = !!paths && paths.every((p) => isPureDocFile(p));
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * 判斷一組自改是否動到安全網。
 * - changedFiles：這次自改會動到的檔案路徑清單。
 * - diffText（選填）：合併後的 diff 內容，用來對「會合法演進的檔」做剎車關鍵字內容偵測。
 * 回傳 critical=true 時，自我進化引擎必須回 owner 拍板、不得自動冷安裝。
 */
export function classifySelfChange(changedFiles: readonly string[], diffText?: string): SelfChangeClassification {
  const hits: SelfChangeHit[] = [];
  const seen = new Set<string>();
  const add = (file: string, reason: string) => {
    const key = `${file}|${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ file, reason });
  };

  for (const raw of changedFiles ?? []) {
    const file = norm(typeof raw === "string" ? raw : "");
    if (!file) continue;
    for (const { pattern, reason } of SAFETY_CRITICAL_PATHS) {
      if (pattern.test(file)) add(file, reason);
    }
  }

  if (typeof diffText === "string" && diffText) {
    const scanned = changedDiffLines(stripDocOnlyDiffSections(diffText));
    for (const { pattern, reason } of SAFETY_RULE_PATTERNS) {
      if (pattern.test(scanned)) add("(diff)", reason);
    }
  }

  return { critical: hits.length > 0, hits };
}

/** 給 owner 看的一行摘要：為什麼這個自改要你拍板。 */
export function describeSelfChangeBlock(result: SelfChangeClassification): string {
  if (!result.critical) return "";
  const reasons = [...new Set(result.hits.map((h) => h.reason))].slice(0, 6).join("；");
  return `此自改動到保護機制，需 owner 拍板（不自動冷安裝）：${reasons}`;
}
