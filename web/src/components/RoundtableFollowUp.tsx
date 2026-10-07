// 快速圓桌結論小卡：最新回合是剛完成的快速圓桌時，掛在輸入框工具列上方，
// 給三個一鍵下一步——照結論執行（轉成一般工作回合）、反方檢驗（再一回合專攻結論弱點）、
// 升級作戰室（結論沒把握或代價高時交給多位同儕深辯）。使用者送出別的指令後自然消失。
import { useState } from "react";
import { t } from "../i18n";
import type { Turn } from "../types";
import { confidenceLabel, latestRoundtable } from "../roundtableResult";
import { roundtableChallengePrompt, roundtableEscalationTopic, roundtableExecutePrompt } from "../roundtablePrompt";
import "../styles/roundtable-followup.css";

export function RoundtableFollowUp({ turns, busy, warroomRunning, onSend, onEscalate }: {
  turns: Turn[] | undefined;
  /** NPC 正在忙時不顯示：小卡只服務「剛出爐、還沒被接手」的結論。 */
  busy: boolean;
  warroomRunning: boolean;
  onSend(text: string): void;
  onEscalate(topic: string): void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const latest = latestRoundtable(turns);
  if (!latest || busy || dismissed === latest.turnKey) return null;
  const { topic, result } = latest;
  const level = confidenceLabel(result.confidence);
  const act = (run: () => void) => { setDismissed(latest.turnKey); run(); };

  return (
    <div className="roundtable-followup" role="group" aria-label={t("圓桌結論")}>
      <header>
        <strong>{t("圓桌結論")}</strong>
        {level && <span className={`roundtable-followup__confidence roundtable-followup__confidence--${result.confidence}`} title={result.confidenceNote}>{t("信心 {level}", { level })}</span>}
        <button type="button" className="roundtable-followup__close" aria-label={t("關閉")} onClick={() => setDismissed(latest.turnKey)}>×</button>
      </header>
      <p className="roundtable-followup__conclusion" title={result.conclusion}>{result.conclusion}</p>
      <div className="roundtable-followup__actions">
        <button
          type="button"
          className="composer-roundtable-toggle"
          title={t("把結論與下一步交給這位 NPC 直接動手；遇到會改變結論的情況會先停下回報")}
          onClick={() => act(() => onSend(roundtableExecutePrompt(topic, result)))}
        >{t("照結論執行")}</button>
        <button
          type="button"
          className="composer-roundtable-toggle"
          title={t("再花一回合，由同一位 NPC 專門攻擊這個結論，判斷維持或修正")}
          onClick={() => act(() => onSend(roundtableChallengePrompt(topic, result.conclusion)))}
        >{t("反方檢驗")}</button>
        <button
          type="button"
          className={`composer-roundtable-toggle composer-roundtable-toggle--warroom${result.suggestsWarroom ? " is-suggested" : ""}`}
          disabled={warroomRunning}
          title={result.suggestsWarroom
            ? t("建議：信心不足或代價高，交給作戰室由多位同儕深辯；約需數分鐘並使用該 LLM 用量")
            : t("交給作戰室由多位同儕深辯，會附上這次的初判；約需數分鐘並使用該 LLM 用量")}
          onClick={() => act(() => onEscalate(roundtableEscalationTopic(topic, { conclusion: result.conclusion, confidence: level })))}
        >{result.suggestsWarroom ? t("升級作戰室（建議）") : t("升級作戰室")}</button>
      </div>
    </div>
  );
}
