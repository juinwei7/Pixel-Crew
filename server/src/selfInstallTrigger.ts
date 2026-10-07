// 自我進化 · 觸發器（「把改好的新版自己真的裝上去」那隻手）。只做快速閘門(動到剎車→回 owner、
// 回滾就緒)，重活(build/test/package/打包/stage/發 pc-selfinstall)交 detached 的 pc-selfrebuild.ps1——
// 它測不過就中止不裝。全自動由 selfInstallAutoEnabled 控制，首次需 owner 看著驗降落傘後才開。
//
// 從 index.ts 搬出來成獨立檔，是為了讓 selfEvolveSafety 能「整檔」把它列為剎車：觸發器跟閘門
// 一樣是保護機制，改掉它的任何一行都等於繞過閘門，不能只靠 diff 行剛好含關鍵字才攔得到。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifySelfChangeCommits,
  describeDirtyWorktree,
  describeSelfChangeRangeBlock,
  resolveSelfInstallRange,
  type SelfChangeCommit,
} from "./selfEvolveInstall.js";
import { checkRollbackReady } from "./selfInstallLifecycle.js";

export type SelfInstallLog = (message: string, detail?: Record<string, unknown>) => void;
export type SelfInstallTriggerResult = { outcome: string; detail?: string };

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 20_000_000 }) }; }
  catch { return { ok: false, out: "" }; }
}
function gitOut(repo: string, args: string[]): string {
  return git(repo, args).out;
}
function gitIsAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try { execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo, stdio: "ignore" }); return true; } catch { return false; }
}

export function readRepoHead(repo: string): string {
  return gitOut(repo, ["rev-parse", "HEAD"]).trim();
}

export function selfInstallAutoEnabled(dataDirectory: string): boolean {
  try { return JSON.parse(readFileSync(join(dataDirectory, "self-install-auto.json"), "utf8"))?.enabled === true; } catch { return false; }
}
export function setSelfInstallAuto(dataDirectory: string, enabled: boolean): void {
  writeFileSync(join(dataDirectory, "self-install-auto.json"), JSON.stringify({ enabled: enabled === true }));
}
export function lastShippedCommit(dataDirectory: string): string {
  try { return String(JSON.parse(readFileSync(join(dataDirectory, "self-install-shipped.json"), "utf8"))?.commit || ""); } catch { return ""; }
}
export function recordShippedCommit(dataDirectory: string, commit: string): void {
  try { writeFileSync(join(dataDirectory, "self-install-shipped.json"), JSON.stringify({ commit })); } catch { /* best-effort */ }
}
// 「已上線」只在新版開機驗過健康後才寫（見 resolvePendingSelfInstallOnBoot）；觸發當下只記「嘗試過」。
// 否則重建失敗時那段範圍會被當成已上線，下次閘門就不再檢查它。嘗試紀錄用來防同一 HEAD 失敗後反覆重試。
export function lastAttemptedCommit(dataDirectory: string): string {
  try { return String(JSON.parse(readFileSync(join(dataDirectory, "self-install-attempt.json"), "utf8"))?.commit || ""); } catch { return ""; }
}
function recordAttemptedCommit(dataDirectory: string, commit: string): void {
  try { writeFileSync(join(dataDirectory, "self-install-attempt.json"), JSON.stringify({ commit, at: new Date().toISOString() })); } catch { /* best-effort */ }
}

// 單一 commit 對其第一個 parent 的改動（root commit 對空樹）。--no-renames：改名拆成刪＋增，舊檔名
// (例如 toolPolicy.ts 被改名走)也會出現在清單裡被檔名規則看到。取不到 diff → null（呼叫端保守處理）。
const SELF_INSTALL_MAX_COMMITS = 200;
function readSelfInstallCommit(repo: string, commit: string): SelfChangeCommit | null {
  const parents = gitOut(repo, ["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/).slice(1);
  const base = parents[0] || "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git 空樹
  const common = ["-c", "core.quotepath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff"];
  const changedFiles = gitOut(repo, [...common, "--name-only", base, commit]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const diffText = gitOut(repo, [...common, base, commit]);
  if (changedFiles.length && !diffText) return null;
  return { commit, changedFiles, diffText };
}

// 透過 wscript+vbs 啟動（app 唯一驗證過可動的 detached 啟動模式，見 tsproxy）：managed node 在無
// 互動 console 的環境下，直接 detached spawn powershell(console 子系統)起不來；wscript(GUI 子系統)
// 可動，再由 vbs 的 WScript.Shell.Run 隱藏視窗叫 powershell(它會替 powershell 正確建 console)。
function launchDetachedRebuild(psCmd: string, vbsPath: string, log: SelfInstallLog): void {
  // VBS 字串字面以 "" 跳脫內嵌雙引號；視窗樣式 0=隱藏、第三參數 False=不等待。
  writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run "${psCmd.replace(/"/g, '""')}", 0, False\r\n`);
  const child = spawn("wscript.exe", [vbsPath], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (err) => log("self-install launch error", { error: (err as Error).message }));
  child.unref();
}

export type TriggerSelfInstallInput = {
  /** PIXEL_CREW_SELF_REPO：要重建並安裝的 repo。 */
  repo: string;
  dataDirectory: string;
  reason: string;
  log: SelfInstallLog;
  /** 測試注入用；預設走 wscript+vbs detached 啟動。 */
  launch?: (psCmd: string, vbsPath: string) => void;
};

export function triggerSelfInstall(input: TriggerSelfInstallInput): SelfInstallTriggerResult {
  const { repo, dataDirectory, reason, log } = input;
  if (!repo || !existsSync(repo)) return { outcome: "repo_not_configured", detail: "PIXEL_CREW_SELF_REPO 未設定或不存在" };
  const head = readRepoHead(repo);
  if (!head) return { outcome: "needs_owner", detail: "讀不到 HEAD，無法確認要裝的改動" };
  // pc-selfrebuild build 的是整個工作目錄，但下面的閘門只看得到已提交的 commit：未提交的改動
  // （包含別的 agent 寫到一半的檔）會不經檢查就被裝上去，所以工作目錄必須乾淨。
  const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return { outcome: "needs_owner", detail: "讀不到工作目錄狀態，無法確認只會裝已檢查過的改動" };
  const dirty = describeDirtyWorktree(status.out);
  if (dirty) return { outcome: "needs_owner", detail: dirty };
  // 這次要裝的改動 = 上次上線 commit..HEAD 的每個 commit（不是只看最新一個，否則被擋的會搭便車）；
  // 任一 commit 動到剎車 → 回 owner，不自裝。上線紀錄不可信 → 退回 HEAD~1..HEAD，自動觸發一律回 owner。
  const shipped = lastShippedCommit(dataDirectory);
  const range = resolveSelfInstallRange({
    head,
    lastShipped: shipped,
    lastShippedIsAncestor: !!shipped && gitIsAncestor(repo, shipped, head),
    trigger: reason === "auto" ? "auto" : "manual",
  });
  let rangeNote = "";
  if (range.kind === "fallback_last_commit") {
    log("self-install range fallback", { reason, head, shipped, blockAsNeedsOwner: range.blockAsNeedsOwner, why: range.reason });
    if (range.blockAsNeedsOwner) return { outcome: "needs_owner", detail: `${range.reason}；自動觸發不冒險，請 owner 確認後手動觸發` };
    rangeNote = `（注意：${range.reason}）`;
  }
  const commitIds = range.kind === "since_shipped"
    ? gitOut(repo, ["rev-list", "--reverse", `${range.base}..${range.head}`]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : range.kind === "fallback_last_commit" ? [head] : [];
  if (range.kind === "since_shipped" && commitIds.length === 0) return { outcome: "needs_owner", detail: "列不出上線範圍內的 commit，無法確認要裝的改動" };
  if (commitIds.length > SELF_INSTALL_MAX_COMMITS) return { outcome: "needs_owner", detail: `距上次上線已累積 ${commitIds.length} 個 commit（>${SELF_INSTALL_MAX_COMMITS}），請 owner 確認` };
  const commits: SelfChangeCommit[] = [];
  for (const id of commitIds) {
    const c = readSelfInstallCommit(repo, id);
    if (!c) return { outcome: "needs_owner", detail: `取不到 commit ${id.slice(0, 7)} 的 diff，無法確認是否動到剎車` };
    commits.push(c);
  }
  const cls = classifySelfChangeCommits(commits);
  log("self-install gate", { reason, range: range.kind, base: range.kind === "since_shipped" ? range.base : undefined, head, checked: cls.checked, criticalCommits: cls.criticalCommits });
  if (cls.critical) return { outcome: "needs_owner", detail: describeSelfChangeRangeBlock(cls) + rangeNote };
  const changed = [...new Set(commits.flatMap((c) => c.changedFiles))];
  // 回滾就緒快速檢查（深比對交給 pc-selfrebuild 的 hash 複檢）。
  const stagedExe = join(dataDirectory, "coldinstall", "Pixel Crew.exe");
  const rollbackExe = join(dataDirectory, "coldinstall", "Pixel Crew.rollback.exe");
  const ready = checkRollbackReady({ stagedExists: existsSync(stagedExe), rollbackExists: existsSync(rollbackExe), rollbackSameAsStaged: false });
  if (!ready.ready) return { outcome: "rollback_not_ready", detail: ready.reason };
  const rebuild = join(repo, "scripts", "windows", "pc-selfrebuild.ps1");
  if (!existsSync(rebuild)) return { outcome: "rebuild_script_missing" };
  const psExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const safeReason = reason.replace(/[\r\n"]/g, " ").slice(0, 120);
  // -ExpectedHead：重建腳本開工前與出貨前都要確認 HEAD 仍是這裡檢查過的那個、工作目錄仍乾淨，
  // 否則閘門放行之後才進來的 commit 會搭便車上線。
  const psCmd = `"${psExe}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${rebuild}" -Repo "${repo}" -Reason "${safeReason}" -ExpectedHead "${head}"`;
  // 寫到無空格路徑（SELF_REPO 有連字號沒空格）：wscript 對含空格的腳本路徑會從空格截斷、
  // 跳出「…\Pixel 沒有副檔名」錯誤（dataDirectory 是 …\Pixel Crew\ 有空格，故不可用）。
  const vbsPath = join(repo, ".pc-selfrebuild-launch.vbs");
  try {
    (input.launch ?? ((cmd, path) => launchDetachedRebuild(cmd, path, log)))(psCmd, vbsPath);
  } catch (error) {
    return { outcome: "launch_failed", detail: (error as Error).message };
  }
  recordAttemptedCommit(dataDirectory, head);
  log("self-install triggered: detached self-rebuild launched", { reason, head, range: range.kind, checked: cls.checked, changed: changed.slice(0, 20), psExe });
  return rangeNote ? { outcome: "fired", detail: rangeNote } : { outcome: "fired" };
}
