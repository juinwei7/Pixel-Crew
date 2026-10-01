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
];

function norm(file: string): string {
  return file.trim().replace(/\\/g, "/");
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
    for (const { pattern, reason } of SAFETY_RULE_PATTERNS) {
      if (pattern.test(diffText)) add("(diff)", reason);
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
