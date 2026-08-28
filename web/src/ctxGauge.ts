/** CTX 量條的「可用量」換算：底盤（系統提示＋記憶＋交接摘要）不計入百分比。
 *  換腦觸發仍是 server 端絕對 170k（對 200k 硬上限的安全緩衝），這裡純顯示。 */

/** server brainSwap 的觸發門檻（tokens）；條滿 100% = 到達此值。 */
export const SWAP_THRESHOLD_TOKENS = 170_000;

/** ctx 在同一 session 內只會漸增；一旦比前一筆掉超過三成，
 *  代表發生了換腦或自動 compact——那一筆就是新的底盤基準。 */
const RESET_DROP_RATIO = 0.7;

export interface CtxGauge {
  /** 0–100，(current − baseline) / (170k − baseline)。 */
  pct: number;
  baselineTokens: number;
  currentTokens: number;
}

/** series = 各回合 contextTokens 依時間排序（舊→新）。空陣列回 null。 */
export function computeCtxGauge(series: number[]): CtxGauge | null {
  if (series.length === 0) return null;
  let baseline = series[0];
  for (let i = 1; i < series.length; i += 1) {
    if (series[i] < series[i - 1] * RESET_DROP_RATIO) baseline = series[i];
  }
  const current = series[series.length - 1];
  const room = SWAP_THRESHOLD_TOKENS - baseline;
  const pct = room <= 0 ? 100 : Math.round(((current - baseline) / room) * 100);
  return { pct: Math.min(100, Math.max(0, pct)), baselineTokens: baseline, currentTokens: current };
}
