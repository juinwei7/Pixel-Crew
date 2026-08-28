// claudeRunner 與 codexRunner 共用的純函式／文案常數。
// 只收「沒有副作用、不吃 runner 執行個體狀態」的邏輯——寫檔、生殺子行程、
// 讀寫 this.* 那類東西兩邊各自留著，硬抽出來只會做出一個假共用、真耦合的模組。
// 型別一律從 protocol.ts 匯入，這裡不另開。

import { dirname, join } from "node:path";
import { config } from "./config.js";
import { documentPrompt } from "./messageDocuments.js";
import { isDangerousCommand } from "./dangerousCommand.js";
import { t } from "./i18n.js";
import type { AutoApproveMode } from "./protocol.js";
import type { ExecutionProfile } from "./providers/session.js";

// 核准卡片顯示的 input／command 都截在同一個長度上限，避免超大 payload 灌爆事件流。
export const MAX_APPROVAL_TEXT_LENGTH = 20_000;

/** 把任意值序列化後夾在長度上限內；超過就截斷並標註「內容已截斷」，無法序列化就退回字串化。 */
export function boundedValue(value: unknown, maxLength = MAX_APPROVAL_TEXT_LENGTH): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) return value;
    return `${serialized.slice(0, maxLength)}\n…[內容已截斷]`;
  } catch {
    return String(value).slice(0, maxLength);
  }
}

/** 指令字串截到跟 boundedValue 一致的上限，核准卡片的 command 欄位顯示用。 */
export function truncateCommand(value: unknown): string {
  return String(value ?? "").slice(0, MAX_APPROVAL_TEXT_LENGTH);
}

/** 唯讀協作／唯讀查詢兩種執行檔位都要收斂成「唯讀」行為（plan mode、read-only sandbox…）。 */
export function isReadOnlyExecutionProfile(profile: ExecutionProfile): boolean {
  return profile === "read_only_collaboration" || profile === "read_only_query";
}

/** 工具呼叫被自動核准放行時，卡片上顯示的原因文字（依模式分三種）。 */
export function autoApproveEnabledReason(mode: AutoApproveMode): string {
  if (mode === "invincible") return t("無限制模式已開啟（不設限）");
  return mode === "full" ? t("完全自動核准已開啟") : t("安全自動核准已開啟");
}

/** 自動核准開著、但這次操作仍卡在人工確認時，卡片上顯示的原因文字。 */
export function autoApproveConfirmReason(mode: AutoApproveMode, detail: string | undefined): string {
  return mode === "full"
    ? t("完全自動核准已開啟，但此操作仍需確認（{detail}）", { detail: String(detail) })
    : t("安全自動核准已開啟，但此操作仍需確認（{detail}）", { detail: String(detail) });
}

/** 指令命中危險清單就回傳中文風險描述，否則 undefined；沒有指令一律 undefined。 */
export function riskReasonFor(command: string | undefined): string | undefined {
  return command ? isDangerousCommand(command).reason : undefined;
}

/** 使用者中止當前回合時的錯誤訊息，兩邊 runner 的 interrupt() 都顯示這句。
 *  刻意保留原文常數（不在模組載入期呼叫 t()，否則切語言不生效）；
 *  使用點呼叫 t(ABORTED_MESSAGE) 在事件送出當下才翻譯。 */
export const ABORTED_MESSAGE = "已中止";

/** 訊息文件附件（PDF／Office／文字檔）的暫存目錄；兩邊 runner 都放在 app-data 底下同一個資料夾。 */
export function messageDocumentsDirectory(): string {
  return join(dirname(config.dbPath), "message-documents");
}

/** 把使用者輸入文字跟文件附件提示串成送給模型的最終文字。 */
export function composeMessageText(text: string, documents: Array<{ name: string; path: string }>): string {
  return [text, documentPrompt(documents)].filter(Boolean).join("\n\n");
}
