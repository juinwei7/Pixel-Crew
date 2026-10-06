// 自我進化引擎 · Stage 3：自冷安裝＋自動回滾的「安全核心」。
//
// 設計原則（determinism split）：所有「要不要裝、裝壞了要不要回滾」的判斷都是純函式、被測死；
// 真正的 I/O（快照前一版、跑冷安裝、驗四件套、回滾）藏在 SelfInstallEffects 介面後面，由外部
// 驅動注入。這樣安全流程本身可用假 effects 完整驗證，不依賴真的動實機。
//
// 鐵律落地：①動到保護機制(classifySelfChange critical) → 不自裝、回 owner。②上線前 build/
// 測試/package 要全綠。③裝前先快照，裝後自驗四件套＋健康檢查，任一不過 → 自動回滾 → 報 owner。
import { classifySelfChange, describeSelfChangeBlock, type SelfChangeClassification } from "./selfEvolveSafety.js";

export type SelfInstallGateInput = {
  /** 這次自改會動到的檔案路徑。 */
  changedFiles: readonly string[];
  /** 合併後 diff（用來偵測「合法演進檔」裡有沒有偷改剎車規則）。 */
  diffText?: string;
  /** 上線前驗證結果。 */
  buildOk: boolean;
  testsOk: boolean;
  packageOk: boolean;
};

export type SelfInstallGateResult =
  | { proceed: true; classification: SelfChangeClassification }
  | { proceed: false; stop: "needs_owner" | "preverify_failed"; reason: string; classification: SelfChangeClassification };

// ───── 自裝比對範圍（「這次要裝的改動」到底是哪些 commit） ─────
// 2026-10 實際漏洞：觸發器只看 HEAD~1..HEAD。4135377 被擋，接著提交 8fca510（無害）→ 只檢查
// 8fca510 → 被擋的 4135377 搭便車一起上線。正解：範圍＝「上次上線 commit..HEAD」，範圍內每個
// commit 都要過閘門。上線紀錄不可信（沒有、或不是 HEAD 的祖先＝歷史被改寫/換分支）時無法知道
// 哪些已上線，只能退回 HEAD~1..HEAD——這等於可能漏看，所以自動觸發一律回 owner；owner 手動觸發
// （人在看）才放行退回範圍，並在結果與 log 標明。

export type SelfInstallTrigger = "auto" | "manual";

export type SelfInstallRangeInput = {
  head: string;
  /** self-install-shipped.json 記的上次上線 commit（沒有＝空字串）。 */
  lastShipped: string;
  /** git merge-base --is-ancestor lastShipped head 的結果（lastShipped 為空時不看）。 */
  lastShippedIsAncestor: boolean;
  trigger: SelfInstallTrigger;
};

export type SelfInstallRange =
  | { kind: "since_shipped"; base: string; head: string }
  | { kind: "up_to_date"; head: string }
  | { kind: "fallback_last_commit"; head: string; blockAsNeedsOwner: boolean; reason: string };

/** 決定自裝要比對的 commit 範圍（純函式）。 */
export function resolveSelfInstallRange(input: SelfInstallRangeInput): SelfInstallRange {
  const head = (input.head || "").trim();
  const shipped = (input.lastShipped || "").trim();
  if (shipped && head && shipped === head) return { kind: "up_to_date", head };
  if (shipped && head && input.lastShippedIsAncestor) return { kind: "since_shipped", base: shipped, head };
  const reason = !shipped
    ? "沒有上次上線紀錄(self-install-shipped.json)，無法確認哪些 commit 已上線，只能檢查 HEAD~1..HEAD"
    : `上次上線 commit ${shipped.slice(0, 10)} 不是 HEAD 的祖先（歷史改寫/換分支），只能檢查 HEAD~1..HEAD`;
  return { kind: "fallback_last_commit", head, blockAsNeedsOwner: input.trigger !== "manual", reason };
}

export type SelfChangeCommit = { commit: string; changedFiles: readonly string[]; diffText: string };
export type SelfChangeCommitHit = { commit: string; file: string; reason: string };
export type SelfChangeRangeClassification = {
  critical: boolean;
  /** 實際檢查過的 commit（給 log／實算核對用）。 */
  checked: string[];
  /** 被判 critical 的 commit。 */
  criticalCommits: string[];
  hits: SelfChangeCommitHit[];
};

/**
 * 範圍內逐 commit 過 classifySelfChange，任一 critical 即整批 critical（不准搭便車）。
 * 逐 commit 而非只看累計 diff：累計 diff 的改動行必出現在某個 commit 的改動行裡，所以逐 commit
 * 一定不比累計少攔；「先拆剎車、下一個 commit 又補回」這種也會被看到（寧可多攔）。
 */
export function classifySelfChangeCommits(commits: readonly SelfChangeCommit[]): SelfChangeRangeClassification {
  const checked: string[] = [];
  const criticalCommits: string[] = [];
  const hits: SelfChangeCommitHit[] = [];
  for (const c of commits) {
    checked.push(c.commit);
    const cls = classifySelfChange(c.changedFiles, c.diffText);
    if (!cls.critical) continue;
    criticalCommits.push(c.commit);
    for (const h of cls.hits) hits.push({ commit: c.commit, file: h.file, reason: h.reason });
  }
  return { critical: criticalCommits.length > 0, checked, criticalCommits, hits };
}

/** 給 owner 看的一行摘要（範圍版）：哪幾個 commit、為什麼。 */
export function describeSelfChangeRangeBlock(result: SelfChangeRangeClassification): string {
  if (!result.critical) return "";
  const reasons = [...new Set(result.hits.map((h) => h.reason))].slice(0, 6).join("；");
  const commits = result.criticalCommits.map((c) => c.slice(0, 7)).join(", ");
  return `此自改動到保護機制，需 owner 拍板（不自動冷安裝）：${reasons}（commit：${commits}）`;
}

/** 上線前閘門：critical(動到剎車) → 回 owner；非 critical 但驗證沒全綠 → 擋下；全綠才放行自裝。 */
export function evaluateSelfInstallGate(input: SelfInstallGateInput): SelfInstallGateResult {
  const classification = classifySelfChange(input.changedFiles, input.diffText);
  if (classification.critical) {
    return { proceed: false, stop: "needs_owner", reason: describeSelfChangeBlock(classification), classification };
  }
  const missing: string[] = [];
  if (!input.buildOk) missing.push("build");
  if (!input.testsOk) missing.push("tests");
  if (!input.packageOk) missing.push("package");
  if (missing.length) {
    return { proceed: false, stop: "preverify_failed", reason: `上線前驗證未全綠：${missing.join("/")}`, classification };
  }
  return { proceed: true, classification };
}

/** 裝後自驗：四件套＋健康檢查。 */
export type PostInstallChecks = {
  exeFresh: boolean;        // exe mtime 進位（新版已換入）
  swappedOk: boolean;       // runtime log 出現 SWAPPED OK
  distHasNewCode: boolean;  // installed dist 含本次新碼
  apiOk: boolean;           // API 回 200
  healthOk: boolean;        // app 起得來、關鍵端點活
};

export type PostInstallResult = { healthy: boolean; mustRollback: boolean; failed: string[] };

/** 全過才 healthy；任一不過即 mustRollback。 */
export function evaluatePostInstall(checks: PostInstallChecks): PostInstallResult {
  const failed: string[] = [];
  if (!checks.exeFresh) failed.push("exe-mtime");
  if (!checks.swappedOk) failed.push("SWAPPED-OK");
  if (!checks.distHasNewCode) failed.push("dist-new-code");
  if (!checks.apiOk) failed.push("api-200");
  if (!checks.healthOk) failed.push("health");
  const healthy = failed.length === 0;
  return { healthy, mustRollback: !healthy, failed };
}

/** 真正動實機的副作用——由外部驅動實作並注入，安全核心只透過這個介面指揮它。 */
export type SelfInstallEffects = {
  /** 快照目前已安裝版本（exe/dist），供失敗時回滾。 */
  snapshot(): Promise<void>;
  /** 執行冷安裝。 */
  install(): Promise<void>;
  /** 蒐集裝後四件套＋健康檢查結果。 */
  collectChecks(): Promise<PostInstallChecks>;
  /** 還原到 snapshot 存下的前一版。 */
  rollback(): Promise<void>;
  /** 進度／結果回報（寫日誌給 owner 看）。 */
  report(stage: SelfInstallStage, detail: unknown): void;
};

export type SelfInstallStage = "gate" | "needs_owner" | "preverify_failed" | "snapshot" | "install" | "verify" | "installed" | "rollback" | "rolled_back" | "rollback_failed";

export type SelfInstallOutcome =
  | { outcome: "needs_owner"; reason: string }
  | { outcome: "preverify_failed"; reason: string }
  | { outcome: "installed" }
  | { outcome: "rolled_back"; failed: string[] }
  | { outcome: "rollback_failed"; failed: string[]; error: string };

/**
 * 自冷安裝主流程（安全核心）：閘門 → 快照 → 裝 → 自驗 → 健康就完成／不健康就回滾。
 * 流程由上面的純函式決策，I/O 全走 fx。回滾本身再失敗 → 回報 rollback_failed（最壞情況也要誠實喊出來）。
 */
export async function runSelfInstall(input: SelfInstallGateInput, fx: SelfInstallEffects): Promise<SelfInstallOutcome> {
  const gate = evaluateSelfInstallGate(input);
  fx.report("gate", { proceed: gate.proceed, critical: gate.classification.critical });
  if (!gate.proceed) {
    fx.report(gate.stop, gate.reason);
    return { outcome: gate.stop, reason: gate.reason };
  }

  fx.report("snapshot", null);
  await fx.snapshot();

  fx.report("install", null);
  await fx.install();

  fx.report("verify", null);
  const checks = await fx.collectChecks();
  const post = evaluatePostInstall(checks);
  if (post.healthy) {
    fx.report("installed", checks);
    return { outcome: "installed" };
  }

  // 不健康 → 自動回滾；回滾若再失敗，誠實回報最壞情況（不能靜默留在半殘狀態）。
  fx.report("rollback", post.failed);
  try {
    await fx.rollback();
  } catch (error) {
    fx.report("rollback_failed", { failed: post.failed, error: (error as Error).message });
    return { outcome: "rollback_failed", failed: post.failed, error: (error as Error).message };
  }
  fx.report("rolled_back", post.failed);
  return { outcome: "rolled_back", failed: post.failed };
}
