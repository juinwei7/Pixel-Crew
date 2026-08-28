import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { BossAssignmentResponse, BossAssignmentResult, ProviderId } from "../types";
import { Modal } from "./Modal";

type ClarificationTurn = { question: string; answer: string };

type Props = {
  preferredWorkspace: string;
  decisionModels?: Array<{ provider: ProviderId; model: string; label: string }>;
  onAssign(input: {
    objective: string;
    acceptanceCriteria: string[];
    preferredWorkspace?: string;
    decisionProvider?: ProviderId;
    decisionModel?: string;
    clarifications?: ClarificationTurn[];
  }): Promise<{ data?: BossAssignmentResponse; error?: string }>;
  onRouted(result: BossAssignmentResult): void;
  onClose(): void;
  embedded?: boolean;
};

export function BossClarificationConversation({
  turns,
  question,
  reply,
  working,
  onReplyChange,
  onSubmit,
}: {
  turns: ClarificationTurn[];
  question: string;
  reply: string;
  working: boolean;
  onReplyChange(value: string): void;
  onSubmit(): void;
}) {
  return <section className="boss-clarification" aria-labelledby="boss-clarification-title" aria-live="polite">
    <header>
      <span>DECISION CLARIFICATION</span>
      <h3 id="boss-clarification-title">{t("決策模型需要你補充")}</h3>
      <p>{t("直接回答即可；原始交辦目標與驗收條件會保持不變。")}</p>
    </header>
    <div className="boss-clarification__thread">
      {turns.map((turn, index) => <div className="boss-clarification__exchange" key={`${index}:${turn.question}`}>
        <p className="boss-clarification__question"><span>{t("決策模型")}</span>{turn.question}</p>
        <p className="boss-clarification__answer"><span>{t("老闆")}</span>{turn.answer}</p>
      </div>)}
      <p className="boss-clarification__question boss-clarification__question--pending"><span>{t("決策模型")}</span>{question}</p>
    </div>
    <label>{t("回覆決策模型")}<textarea
      autoFocus
      value={reply}
      maxLength={2000}
      rows={3}
      placeholder={t("例如：是整間公司的所有同事。")}
      disabled={working}
      onChange={(event) => onReplyChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
    /></label>
    <div className="collaboration-dialog__actions boss-clarification__actions">
      <button type="button" className="collaboration-dialog__primary" disabled={working || !reply.trim()} onClick={onSubmit}>
        {working ? t("決策模型正在重新判斷…") : t("送出回覆")}
      </button>
    </div>
  </section>;
}

export function BossAssignmentDialog({ preferredWorkspace, decisionModels = [], onAssign, onRouted, onClose, embedded = false }: Props) {
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [decisionKey, setDecisionKey] = useState("");
  const [clarifications, setClarifications] = useState<ClarificationTurn[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ×／Esc 共用同一個關閉入口：處理中不准關（僅非 embedded 模式會用到，embedded 不提供關閉）。
  function closeIfIdle() { if (!working) onClose(); }

  useEffect(() => {
    let saved = "";
    try {
      saved = localStorage.getItem(`pixel-crew:boss-decision-model:${preferredWorkspace}`) ?? "";
    } catch {
      saved = "";
    }
    setDecisionKey(decisionModels.some((option) => `${option.provider}:${option.model}` === saved) ? saved : "");
  }, [decisionModels, preferredWorkspace]);

  async function decide(nextClarifications: ClarificationTurn[]) {
    const decision = decisionModels.find((option) => `${option.provider}:${option.model}` === decisionKey);
    if (!objective.trim() || working) return;
    setWorking(true);
    setError(null);
    const result = await onAssign({
      objective: objective.trim(),
      acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean),
      preferredWorkspace,
      decisionProvider: decision?.provider,
      decisionModel: decision?.model,
      clarifications: nextClarifications,
    });
    setWorking(false);
    if (result.error || !result.data) {
      setError(result.error || t("無法交辦工作"));
      return;
    }
    if ("clarification" in result.data) {
      setClarifications(nextClarifications);
      setPendingQuestion(result.data.clarification.question);
      setReply("");
      return;
    }
    onRouted(result.data);
  }

  function submit() {
    void decide([]);
  }

  function submitClarification() {
    if (!pendingQuestion || !reply.trim() || working) return;
    void decide([...clarifications, { question: pendingQuestion, answer: reply.trim() }]);
  }

  const clarificationActive = pendingQuestion !== null;
  const inner = <>
      <header className="handoff-dialog__header">
        <span>BOSS DESK · SINGLE ENTRY</span>
        <h2>{t("交辦一件工作")}</h2>
        <p>{t("只要描述目標。Pixel Crew 會依部門職責與 NPC 職務找到最合適的團隊、直接開始，最後帶回一份部門報告。")}</p>
      </header>
      <div className="collaboration-dialog__form boss-assignment__form">
        <details className="boss-assignment__advanced"><summary>{t("進階設定")} <span>{t("選填")}</span></summary><label>{t("決策模型")} <small>{t("預設會自動選擇可用的 Claude 或 Codex；這裡只用來覆寫")}</small><select value={decisionKey} disabled={working || clarificationActive} onChange={(event) => {
          const value = event.target.value;
          setDecisionKey(value);
          try {
            if (value) localStorage.setItem(`pixel-crew:boss-decision-model:${preferredWorkspace}`, value);
            else localStorage.removeItem(`pixel-crew:boss-decision-model:${preferredWorkspace}`);
          } catch {
            // Local storage can be unavailable in hardened browser contexts.
          }
        }}>
          <option value="">{t("自動選擇")}</option>
          {decisionModels.map((option) => <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>{option.label}</option>)}
        </select></label></details>
        <label>{t("交辦目標")}<textarea autoFocus={!clarificationActive} value={objective} disabled={working || clarificationActive} maxLength={4000} rows={4} placeholder={t("例如：完成會員權限 API，包含實作、測試與文件")} onChange={(event) => { setObjective(event.target.value); setError(null); }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
        }} /></label>
        <label>{t("驗收條件")} <small>{t("選填，每行一項，最多 8 項")}</small><textarea value={criteria} disabled={working || clarificationActive} rows={4} placeholder={t("留空時，部門會以「完成目標、合理驗證、回報風險」為準\n或自行列出：\n完整測試通過\n最後提交一份部門報告")} onChange={(event) => setCriteria(event.target.value)} /></label>
      </div>
      {clarificationActive && <BossClarificationConversation
        turns={clarifications}
        question={pendingQuestion}
        reply={reply}
        working={working}
        onReplyChange={(value) => { setReply(value); setError(null); }}
        onSubmit={submitClarification}
      />}
      {error && <div className="handoff-dialog__error" role="alert">{error}</div>}
      {!clarificationActive && <div className="collaboration-dialog__actions boss-assignment__actions">
        <button type="button" className="collaboration-dialog__primary" disabled={working || !objective.trim()} onClick={submit}>{working ? t("正在理解並選擇部門…") : t("交辦給部門")}</button>
      </div>}
      <small className="boss-assignment__policy">{t("依部門職責與 NPC 職務自動分工；權限、認證與重大決定仍會回來找你。")}</small>
    </>;

  if (embedded) return <section className="boss-assignment boss-assignment--embedded" aria-label={t("交辦一件工作")}>
    <div className="handoff-dialog__card boss-assignment__card mission-dialog__card--embedded">{inner}</div>
  </section>;
  return <Modal label={t("交辦一件工作")} overlayClassName="handoff-dialog boss-assignment" cardClassName="handoff-dialog__card boss-assignment__card" closeClassName="handoff-dialog__close" closeLabel={t("關閉老闆交辦")} onClose={closeIfIdle}>{inner}</Modal>;
}
