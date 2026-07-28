import { useEffect, useRef, useState } from "react";
import type { BossAssignmentResponse, BossAssignmentResult, ProviderId } from "../types";
import { useFocusTrap } from "../hooks/useFocusTrap";

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
      <h3 id="boss-clarification-title">決策模型需要你補充</h3>
      <p>直接回答即可；原始交辦目標與驗收條件會保持不變。</p>
    </header>
    <div className="boss-clarification__thread">
      {turns.map((turn, index) => <div className="boss-clarification__exchange" key={`${index}:${turn.question}`}>
        <p className="boss-clarification__question"><span>決策模型</span>{turn.question}</p>
        <p className="boss-clarification__answer"><span>老闆</span>{turn.answer}</p>
      </div>)}
      <p className="boss-clarification__question boss-clarification__question--pending"><span>決策模型</span>{question}</p>
    </div>
    <label>回覆決策模型<textarea
      autoFocus
      value={reply}
      maxLength={2000}
      rows={3}
      placeholder="例如：是整間公司的所有同事。"
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
        {working ? "決策模型正在重新判斷…" : "送出回覆"}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const embeddedRef = useRef<HTMLElement>(null);
  useFocusTrap(dialogRef, !embedded);

  useEffect(() => {
    if (embedded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !working) onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [embedded, onClose, working]);

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
      setError(result.error || "無法交辦工作");
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
  const content = <div className={`handoff-dialog__card boss-assignment__card ${embedded ? "mission-dialog__card--embedded" : ""}`}>
      <button type="button" className="handoff-dialog__close" onClick={onClose} disabled={working} aria-label="關閉老闆交辦">×</button>
      <header className="handoff-dialog__header">
        <span>BOSS DESK · SINGLE ENTRY</span>
        <h2 id="boss-assignment-title">交辦一件工作</h2>
        <p>只要描述目標。Pixel Crew 會依部門職責與 NPC 職務找到最合適的團隊、直接開始，最後帶回一份部門報告。</p>
      </header>
      <div className="collaboration-dialog__form boss-assignment__form">
        <details className="boss-assignment__advanced"><summary>進階設定 <span>選填</span></summary><label>決策模型 <small>預設會自動選擇可用的 Claude 或 Codex；這裡只用來覆寫</small><select value={decisionKey} disabled={working || clarificationActive} onChange={(event) => {
          const value = event.target.value;
          setDecisionKey(value);
          try {
            if (value) localStorage.setItem(`pixel-crew:boss-decision-model:${preferredWorkspace}`, value);
            else localStorage.removeItem(`pixel-crew:boss-decision-model:${preferredWorkspace}`);
          } catch {
            // Local storage can be unavailable in hardened browser contexts.
          }
        }}>
          <option value="">自動選擇</option>
          {decisionModels.map((option) => <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>{option.label}</option>)}
        </select></label></details>
        <label>交辦目標<textarea autoFocus={!clarificationActive} value={objective} disabled={working || clarificationActive} maxLength={4000} rows={4} placeholder="例如：完成會員權限 API，包含實作、測試與文件" onChange={(event) => { setObjective(event.target.value); setError(null); }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
        }} /></label>
        <label>驗收條件 <small>選填，每行一項，最多 8 項</small><textarea value={criteria} disabled={working || clarificationActive} rows={4} placeholder={"留空時，部門會以「完成目標、合理驗證、回報風險」為準\n或自行列出：\n完整測試通過\n最後提交一份部門報告"} onChange={(event) => setCriteria(event.target.value)} /></label>
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
        <button type="button" className="collaboration-dialog__primary" disabled={working || !objective.trim()} onClick={submit}>{working ? "正在理解並選擇部門…" : "交辦給部門"}</button>
      </div>}
      <small className="boss-assignment__policy">依部門職責與 NPC 職務自動分工；權限、認證與重大決定仍會回來找你。</small>
    </div>;

  if (embedded) return <section ref={embeddedRef} className="boss-assignment boss-assignment--embedded" aria-labelledby="boss-assignment-title">{content}</section>;
  return <div ref={dialogRef} className="handoff-dialog boss-assignment" role="dialog" aria-modal="true" aria-labelledby="boss-assignment-title">{content}</div>;
}
