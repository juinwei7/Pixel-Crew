import { useEffect, useRef, useState } from "react";
import type { ApprovalDecision, ApprovalItem, ToolCallItem, Turn, TurnItem } from "../types";
import type { TaskLogView } from "../uiPreferences";
import { RichText } from "./RichText";

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolMeta(name: string): { label: string; mcpServer: string | null } {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { label: parts.slice(2).join("__") || name, mcpServer: parts[1] ?? null };
  }
  return { label: name, mcpServer: null };
}

function CopyButton({ value, label = "複製" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="copy-button" title={label} aria-label={label} onClick={() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }}>{copied ? "✓" : "⧉"}</button>;
}

function ToolRow({ item }: { item: ToolCallItem }) {
  const [open, setOpen] = useState(item.status === "running" || item.isError);
  const { label, mcpServer } = toolMeta(item.name);

  useEffect(() => {
    if (item.status === "running" || item.isError) setOpen(true);
  }, [item.status, item.isError]);

  return (
    <div className={`tool-row ${item.isError ? "tool-row--error" : ""}`}>
      <button className="tool-row__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-row__status">
          {item.status === "running" ? (
            <span className="spinner" />
          ) : item.isError ? (
            "✕"
          ) : (
            "✓"
          )}
        </span>
        <span className="tool-row__name">{label}</span>
        {mcpServer && <span className="tool-row__badge">MCP·{mcpServer}</span>}
        <span className="tool-row__chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-row__detail">
          <div className="tool-row__label">INPUT <CopyButton value={formatValue(item.input)} label="複製 INPUT" /></div>
          <pre>{formatValue(item.input)}</pre>
          {item.output !== undefined && (
            <>
              <div className="tool-row__label">OUTPUT {item.status === "running" && <span>· LIVE</span>} <CopyButton value={formatValue(item.output)} label="複製 OUTPUT" /></div>
              <pre>{formatValue(item.output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item, onApprove }: {
  item: ApprovalItem;
  onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null>;
}) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = item.status === "pending";

  async function decide(decision: ApprovalDecision) {
    if (!onApprove || !pending || submitting) return;
    setSubmitting(decision);
    setError(null);
    const message = await onApprove(item.request.id, decision);
    if (message) {
      setError(message);
      setSubmitting(null);
    }
  }

  const decisionLabel = item.decision === "allow_once"
    ? "已允許一次"
    : item.decision === "allow_session"
      ? "本次工作階段已允許"
      : item.decision === "auto_allow"
        ? "已自動核准"
        : "已拒絕";

  return (
    <div className={`approval-card ${pending ? "approval-card--pending" : "approval-card--resolved"}`}>
      <div className="approval-card__head">
        <span className="approval-card__icon">!</span>
        <div><strong>{item.request.title}</strong><small>{item.request.reason || "Agent 需要你的核准才能繼續"}</small></div>
      </div>
      {item.request.command && <pre className="approval-card__command">{item.request.command}</pre>}
      {item.request.cwd && <div className="approval-card__cwd">工作目錄 · {item.request.cwd}</div>}
      {!item.request.command && <pre className="approval-card__command">{formatValue(item.request.input)}</pre>}
      {pending ? (
        <div className="approval-card__actions">
          <button type="button" disabled={!onApprove || Boolean(submitting)} onClick={() => void decide("deny")}>拒絕</button>
          {item.request.decisions.includes("allow_session") && (
            <button type="button" disabled={!onApprove || Boolean(submitting)} onClick={() => void decide("allow_session")}>本次皆允許</button>
          )}
          <button className="approval-card__allow" type="button" disabled={!onApprove || Boolean(submitting)} onClick={() => void decide("allow_once")}>
            {submitting === "allow_once" ? "處理中…" : "允許這一次"}
          </button>
        </div>
      ) : <div className={`approval-card__decision approval-card__decision--${item.decision}`}>{decisionLabel}</div>}
      {error && <div className="approval-card__error">{error}</div>}
    </div>
  );
}

function ToolGroup({ items, summary }: { items: ToolCallItem[]; summary: boolean }) {
  const urgent = items.some((item) => item.status === "running" || item.isError);
  const failed = items.filter((item) => item.isError).length;
  const running = items.filter((item) => item.status === "running").length;
  const [open, setOpen] = useState(failed > 0 || (running > 0 && !summary));

  useEffect(() => {
    if (failed > 0 || (urgent && !summary)) setOpen(true);
  }, [failed, urgent, summary]);

  return (
    <div className={`tool-group ${failed ? "tool-group--error" : ""}`}>
      <button className="tool-group__head" onClick={() => setOpen((value) => !value)}>
        <span className="tool-group__mark">{running ? <span className="spinner" /> : "⌘"}</span>
        <span className="tool-group__title">工具活動</span>
        <span className="tool-group__summary">
          {items.length} 項{failed ? ` · ${failed} 失敗` : ""}
        </span>
        <span className="tool-group__chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-group__items">
          {items.map((item) => <ToolRow key={item.key} item={item} />)}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-row">
      <button className="thinking-row__head" onClick={() => setOpen((v) => !v)}>
        💭 思考{open ? "" : "…"}
      </button>
      {open && (
        <div className="thinking-row__body">
          <RichText text={text} compact />
        </div>
      )}
    </div>
  );
}

function TurnItems({ items, status, view, onApprove }: { items: TurnItem[]; status: Turn["status"]; view: TaskLogView; onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null> }) {
  let finalTextIndex = -1;
  if (status === "done") {
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index].kind === "assistant_text") {
        finalTextIndex = index;
        break;
      }
    }
  }
  const withoutPending = items.filter((item) => item.kind !== "approval" || item.status !== "pending");
  const projected = view === "activity" ? withoutPending : withoutPending.filter((item) => {
    if (item.kind === "system_error" || item.kind === "thinking") return true;
    if (item.kind === "tool_call") return true;
    const index = items.findIndex((source) => source.key === item.key);
    return status === "running" ? index === [...items].map((source) => source.kind).lastIndexOf("assistant_text") : index === finalTextIndex;
  });
  const grouped: Array<TurnItem | { kind: "tool_group"; key: string; items: ToolCallItem[] }> = [];
  for (const item of projected) {
    if (item.kind === "tool_call") {
      const previous = grouped[grouped.length - 1];
      if (previous?.kind === "tool_group") previous.items.push(item);
      else grouped.push({ kind: "tool_group", key: `tools-${item.key}`, items: [item] });
    } else {
      grouped.push(item);
    }
  }

  return (
    <div className="turn-card__items">
      {grouped.map((item) => {
        if (item.kind === "tool_group") {
          return item.items.length === 1
            ? <ToolRow key={item.key} item={item.items[0]} />
            : <ToolGroup key={item.key} items={item.items} summary={view === "summary"} />;
        }
        if (item.kind === "tool_call") return <ToolRow key={item.key} item={item} />;
        if (item.kind === "approval") return <ApprovalCard key={item.key} item={item} onApprove={onApprove} />;
        if (item.kind === "thinking") return <ThinkingRow key={item.key} text={item.text} />;
        if (item.kind === "system_error") {
          return (
            <div key={item.key} className="turn-error">
              ✕ {item.text}
            </div>
          );
        }
        const sourceIndex = items.findIndex((source) => source.key === item.key);
        const isFinal = sourceIndex === finalTextIndex;
        return (
          <div key={item.key} className={`turn-text ${isFinal ? "turn-text--final" : ""}`}>
            {isFinal && <div className="turn-text__label">FINAL RESPONSE <CopyButton value={item.text} label="複製最終回覆" /></div>}
            <RichText text={item.text} />
          </div>
        );
      })}
    </div>
  );
}

function statusChip(status: Turn["status"], waitingForApproval: boolean) {
  if (waitingForApproval) return <span className="turn-chip turn-chip--waiting">等待核准</span>;
  if (status === "running") return <span className="turn-chip turn-chip--running">進行中</span>;
  if (status === "error") return <span className="turn-chip turn-chip--error">失敗</span>;
  return <span className="turn-chip turn-chip--done">完成</span>;
}

function TurnCard({ turn, isLatest, view, onApprove }: { turn: Turn; isLatest: boolean; view: TaskLogView; onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null> }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? (isLatest || turn.status === "running" || turn.status === "error");
  const waitingForApproval = turn.items.some((item) => item.kind === "approval" && item.status === "pending");

  return (
    <div className={`turn-card turn-card--${turn.status}`}>
      <div className="turn-card__head">
        <button className="turn-card__toggle" type="button" onClick={() => setExpanded(!open)}>
          <span className="turn-card__cmd">{turn.command}</span>
          {statusChip(turn.status, waitingForApproval)}
        </button>
        <CopyButton value={turn.command} label="複製指令" />
      </div>
      {open && (
        <>
          <TurnItems items={turn.items} status={turn.status} view={view} onApprove={onApprove} />
          {turn.status !== "running" && turn.durationMs !== undefined && (
            <div className="turn-card__foot">
              {(turn.durationMs / 1000).toFixed(1)}s{turn.costUsd ? ` · $${turn.costUsd.toFixed(4)}` : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function QuestLog({ turns, view = "summary", searchQuery = "", onApprove }: { turns: Turn[]; view?: TaskLogView; searchQuery?: string; onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null> }) {
  const logRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastTurn = turns[turns.length - 1];
  const itemCount = lastTurn?.items.length ?? 0;

  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, turns.length, itemCount, lastTurn?.status, atBottom]);

  const pending = turns.flatMap((turn) => turn.items.filter((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending"));
  const needle = searchQuery.trim().toLowerCase();
  const visibleTurns = needle ? turns.filter((turn) => `${turn.command} ${turn.items.map((item) => "text" in item ? item.text : JSON.stringify(item)).join(" ")}`.toLowerCase().includes(needle)) : turns;

  return (
    <div className="quest-log" ref={logRef} onScroll={() => {
      const el = logRef.current;
      if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    }}>
      {pending.length > 0 && <div className="approval-shelf" role="alert" aria-live="assertive"><div className="approval-shelf__label">需要你的核准</div>{pending.map((item) => <ApprovalCard key={item.key} item={item} onApprove={onApprove} />)}</div>}
      {turns.length === 0 && (
        <div className="quest-log__empty">
          在下面下指令,例如「幫我完成工作」——小人會去任務板查還沒做完的事。
          <br />
          輸入 <code>/</code> 可以看可用的斜線指令。
        </div>
      )}
      {turns.length > 0 && visibleTurns.length === 0 && (
        <div className="quest-log__no-results">找不到符合「{searchQuery.trim()}」的任務內容</div>
      )}
      {visibleTurns.map((turn, i) => (
        <TurnCard key={turn.key} turn={turn} isLatest={i === visibleTurns.length - 1} view={view} onApprove={onApprove} />
      ))}
      {!atBottom && <button type="button" className="quest-log__latest" onClick={() => {
        const el = logRef.current;
        el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        setAtBottom(true);
      }}>↓ 最新內容</button>}
    </div>
  );
}
