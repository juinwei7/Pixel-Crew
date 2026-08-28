/**
 * CTX 高水位自動換腦的純決策核心。index.ts 的 brainSwapHook 收到 RunnerEvent
 * 後把當下狀態整理成 BrainSwapObservation 丟進來，這裡回傳「該做什麼」——
 * 實際的 IO（換 session、送訊息、計時器、pending/cooldown 集合維護）仍留在
 * index.ts。決策規則與訊息文字自 index.ts 原封搬入，行為不變：
 * - turn_end 的 contextTokens ≥ 170k（200k 視窗的 85%）才觸發
 * - 新 session 未滿 3 回合、或距上次換腦不到 10 分鐘 → 冷卻不換（每 session 提醒一次）
 * - 換腦後仍在前 3 回合、且這幾回合「連續」都超標 → 固定底盤太肥，永久停用
 *   （重啟伺服器才重新評估；只放行過一次熱身工作的短暫尖峰，避免 host 一接手就
 *   被交辦超重工作時被誤判成底盤肥）
 * - 🏛/🔍 開頭的短命工、非 claude provider、交接/協作/Mission 進行中 → 不換
 */
import type { RunnerEvent } from "./protocol.js";
import { t } from "./i18n.js";

export const BRAIN_SWAP_THRESHOLD_TOKENS = 170_000; // 200k 視窗的 85%
export const BRAIN_SWAP_MIN_TURNS = 3; // 新 session 至少跑過這麼多回合才准再換
export const BRAIN_SWAP_COOLDOWN_MS = 10 * 60_000; // 兩次換腦的最短間隔
export const BRAIN_SWAP_DISABLE_STREAK = 3; // 換腦後連續這麼多回合都超標才永久停用

export type BrainSwapObservation = {
  event: RunnerEvent;
  provider: string;
  workerName: string;
  /** 這顆 worker 是否已送出「寫交接摘要」請求、正在等摘要回合。 */
  pending: boolean;
  /** 這顆 worker 的自動換腦是否已被永久停用。 */
  disabled: boolean;
  /** 距上次換腦後「連續」超標的 turn_end 數（含本回合）；低於門檻的一回合會清零。 */
  overflowStreak: number;
  /** handoff／協作／部門 Mission 進行中。 */
  engaged: boolean;
  /** 目前 session 已完成的回合數。 */
  sessionTurns: number;
  /** 上次換腦完成的時間戳；從未換過腦為 null。 */
  lastSwapAt: number | null;
  /** 冷卻提醒是否已對這顆 session 發過一次。 */
  cooldownNoted: boolean;
  now: number;
};

export type BrainSwapDecision =
  | { action: "ignore" }
  /** error 事件：清掉 pending 旗標（若有），其餘不動。 */
  | { action: "clear_pending" }
  /** 摘要回合失敗或空白：放棄本次換腦，清掉 pending。 */
  | { action: "abort_swap" }
  /** 摘要回合成功結束：以 summary 執行換腦。 */
  | { action: "complete_swap"; summary: string }
  /** 換腦後首回合又超標：永久停用並發出說明訊息。 */
  | { action: "disable"; message: string }
  /** 冷卻中：message 非 null 時代表這顆 session 第一次提醒，需要記錄。 */
  | { action: "cooldown"; message: string | null }
  /** 觸發換腦：先請 NPC 寫交接摘要（message 為聊天串上的宣告文字）。 */
  | { action: "start_swap"; message: string };

export function decideBrainSwap(input: BrainSwapObservation): BrainSwapDecision {
  const { event } = input;
  if (event.type === "error") return { action: "clear_pending" };
  if (event.type !== "turn_end") return { action: "ignore" };
  if (input.provider !== "claude") return { action: "ignore" };
  if (input.workerName.startsWith("🏛") || input.workerName.startsWith("🔍")) return { action: "ignore" };

  if (input.pending) {
    // 摘要回合結束 → 執行換腦
    if (event.isError) return { action: "abort_swap" };
    const summary = event.resultText.trim();
    if (!summary) return { action: "abort_swap" };
    return { action: "complete_swap", summary };
  }

  if (event.isError) return { action: "ignore" };
  if (typeof event.contextTokens !== "number" || event.contextTokens < BRAIN_SWAP_THRESHOLD_TOKENS) return { action: "ignore" };
  if (input.disabled) return { action: "ignore" };
  if (input.engaged) return { action: "ignore" };
  if (input.lastSwapAt != null && input.sessionTurns <= BRAIN_SWAP_DISABLE_STREAK && input.overflowStreak >= BRAIN_SWAP_DISABLE_STREAK) {
    return {
      action: "disable",
      message: t(
        "🧠 換腦後連續 {n} 回合 context 都達 {kb}k——固定底盤（系統提示＋記憶＋MCP／外掛）本身快吃滿視窗，再換也沒用，已停用這顆 NPC 的自動換腦。請精簡長期記憶或關掉用不到的 MCP／外掛後重啟伺服器。",
        { n: input.overflowStreak, kb: Math.round(event.contextTokens / 1000) },
      ),
    };
  }
  // 冷卻防護：剛換過腦（回合太少或間隔太短）就又滿，多半是固定底盤（系統提示＋
  // 記憶＋MCP 工具）太肥，再換也只是重複燒錢。冷卻期內不換、交給 CLI 自己壓縮，
  // 每顆 session 只提醒一次，避免換腦→立刻又換腦的無限迴圈。
  if (input.sessionTurns < BRAIN_SWAP_MIN_TURNS || input.now - (input.lastSwapAt ?? 0) < BRAIN_SWAP_COOLDOWN_MS) {
    return {
      action: "cooldown",
      message: input.cooldownNoted
        ? null
        : t(
            "🧠 context 已達 {kb}k，但距離上次換腦太近，冷卻中先不換。若這則訊息常出現，代表固定底盤太肥——考慮精簡長期記憶、關掉用不到的 MCP／外掛。",
            { kb: Math.round(event.contextTokens / 1000) },
          ),
    };
  }
  return {
    action: "start_swap",
    message: t("🧠 context 已達 {kb}k/200k，啟動自動換腦——先請 NPC 寫交接摘要", { kb: Math.round(event.contextTokens / 1000) }),
  };
}
