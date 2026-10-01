// 自我進化引擎 · 回滾點生命週期（純核心）。
//
// 解決我在接實機時發現的致命坑：app 不保存自己的安裝器，naive 回滾會回到「更舊的版本」而非
// 「上一個好版本」，等於倒退／丟掉好工作——而且一旦發生不可逆。本模組把「回滾永遠能回到上一個
// 好版本」這條正確性做成純函式、測死：
//   角色三支安裝器 — staged(即將裝的新版) / rollback(上一個好版，失敗時還原用) / installed(現役)
//   規則 — 成功後才晉升 rollback := 這次裝成功的版本；失敗則 staged := rollback 重裝回舊好版。
//   鐵律 — 開火前必須確認 rollback 存在且 ≠ 新版，否則禁止自裝（不然就是那個救不回的坑）。

export type FileOp = { op: "copy"; from: string; to: string };

export type RollbackReadiness = { ready: boolean; reason: string };

/**
 * 開火前的回滾就緒檢查（最重要的一道閘）：
 * - 沒有 staged 新安裝器 → 不能裝。
 * - 沒有 rollback（上一個好版安裝器）→ 不能裝（失敗就救不回）。
 * - rollback 內容 == staged（新版）→ 不能裝：回滾點竟指向新版，失敗時會「回滾到壞版本」或根本回不去。
 */
export function checkRollbackReady(input: {
  stagedExists: boolean;
  rollbackExists: boolean;
  rollbackSameAsStaged: boolean;
}): RollbackReadiness {
  if (!input.stagedExists) return { ready: false, reason: "無 staged 新安裝器，無法自裝" };
  if (!input.rollbackExists) return { ready: false, reason: "無回滾點（上一個好版安裝器），禁止自裝——失敗將無法還原" };
  if (input.rollbackSameAsStaged) return { ready: false, reason: "回滾點＝新版，禁止自裝——失敗將回不到上一個好版（倒退/救不回）" };
  return { ready: true, reason: "回滾點就緒，指向上一個好版" };
}

/**
 * 自裝成功（裝後健康確認）後才執行的晉升：把「這次裝成功的安裝器(staged)」存成新的 rollback，
 * 供下一次自裝回滾。關鍵：晉升只在成功後做——失敗絕不晉升，才能保住「上一個好版」。
 */
export function planPromoteOnSuccess(paths: { staged: string; rollback: string }): FileOp[] {
  return [{ op: "copy", from: paths.staged, to: paths.rollback }];
}

/**
 * 自裝失敗（裝後不健康）時的還原：把 rollback(上一個好版) 覆回 staged，之後重跑安裝器即回到舊好版。
 */
export function planRollbackRestore(paths: { staged: string; rollback: string }): FileOp[] {
  return [{ op: "copy", from: paths.rollback, to: paths.staged }];
}
