import { useEffect, useRef, useState } from "react";
import type { ApprovalDecision, ApprovalItem, ToolCallItem, Turn, TurnItem } from "../types";
import type { TaskLogView } from "../uiPreferences";
import { extractMarkdownHeadings, RichText } from "./RichText";
import { parseMcpToolName as toolMeta } from "../mcpToolName";

const focusScrollPositions = new Map<string, number>();
const PIN_STORAGE_KEY = "pixel-crew-pinned-reports-v1";
// A worker running for a long time can accumulate hundreds of turns, each
// fully rendered (markdown, tool call bodies, etc.) with no windowing —
// unbounded growth becomes real render/scroll jank. True virtualization
// would unmount off-screen turns, but scroll-to-turn (search results, report
// navigation) and pinning here all resolve turns via `document.getElementById`,
// which breaks the moment a turn isn't mounted. Instead: only ever render the
// most recent chunk by default, with a "load earlier" affordance — cheap,
// keeps every existing DOM-id-based feature working, and is a no-op for the
// vast majority of conversations that never reach the cap.
const RENDER_CHUNK = 200;

function focusTurnId(key: string): string {
  return `focus-turn-${encodeURIComponent(key)}`;
}

function searchTurnId(key: string): string {
  return `search-turn-${encodeURIComponent(key)}`;
}

function finalReadableText(turn: Turn): string {
  const item = [...turn.items].reverse().find((candidate) => candidate.kind === "assistant_text" || candidate.kind === "system_error");
  return item && "text" in item ? item.text : "";
}

function reportMarkdown(turns: Turn[]): string {
  return turns.map((turn) => `# ${turn.command}\n\n${finalReadableText(turn)}`).filter((section) => section.trim()).join("\n\n---\n\n");
}

function readPinnedReports(readerKey?: string): Set<string> {
  if (!readerKey || typeof window === "undefined") return new Set();
  try {
    const store = JSON.parse(window.localStorage.getItem(PIN_STORAGE_KEY) ?? "{}");
    return new Set(Array.isArray(store?.[readerKey]) ? store[readerKey] : []);
  } catch {
    return new Set();
  }
}

function persistPinnedReports(readerKey: string | undefined, pinned: Set<string>) {
  if (!readerKey || typeof window === "undefined") return;
  try {
    const store = JSON.parse(window.localStorage.getItem(PIN_STORAGE_KEY) ?? "{}");
    store[readerKey] = [...pinned];
    window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Pin persistence is best-effort when browser storage is unavailable.
  }
}

function ReportActions({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="focus-report-actions">
    <button type="button" disabled={!markdown} onClick={() => {
      void navigator.clipboard?.writeText(markdown).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      });
    }}>{copied ? "已複製" : "複製整份"}</button>
    <button type="button" disabled={!markdown} onClick={() => {
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `pixel-crew-report-${new Date().toISOString().slice(0, 10)}.md`;
      link.click();
      URL.revokeObjectURL(url);
    }}>匯出 .md</button>
  </div>;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return text;
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((part, index) => part.toLocaleLowerCase() === needle.toLocaleLowerCase() ? <mark className="search-highlight" key={index}>{part}</mark> : part)}</>;
}

function searchableTurnText(turn: Turn, focusMode: boolean): string {
  const items = focusMode ? turn.items.filter((item) => item.kind === "assistant_text" || item.kind === "system_error") : turn.items;
  return `${turn.command} ${items.map((item) => "text" in item ? item.text : JSON.stringify(item)).join(" ")}`;
}

function occurrenceCount(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  const haystack = text.toLocaleLowerCase();
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor += Math.max(needle.length, 1);
  }
  return count;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

export function ToolRow({ item }: { item: ToolCallItem }) {
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

export function ToolGroup({ items, summary }: { items: ToolCallItem[]; summary: boolean }) {
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

function TurnItems({ items, status, view, focusMode, turnKey, highlight, onApprove }: { items: TurnItem[]; status: Turn["status"]; view: TaskLogView; focusMode: boolean; turnKey: string; highlight: string; onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null> }) {
  let finalTextIndex = -1;
  if (status !== "running") {
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index].kind === "assistant_text") {
        finalTextIndex = index;
        break;
      }
    }
  }
  const withoutPending = items.filter((item) => item.kind !== "approval" || item.status !== "pending");
  const projected = focusMode ? withoutPending.filter((item) => {
    if (item.kind === "system_error") return true;
    if (item.kind !== "assistant_text") return false;
    const index = items.findIndex((source) => source.key === item.key);
    return status === "running"
      ? index === [...items].map((source) => source.kind).lastIndexOf("assistant_text")
      : index === finalTextIndex;
  }) : view === "activity" ? withoutPending : withoutPending.filter((item) => {
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
      {focusMode && status === "running" && grouped.length === 0 && (
        <div className="focus-turn-pending" role="status" aria-live="polite">
          <span className="focus-turn-pending__dot" aria-hidden="true" />
          <span><strong>指令已送出</strong>，NPC 正在處理中…</span>
        </div>
      )}
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
            <RichText text={item.text} headingPrefix={focusMode ? focusTurnId(turnKey) : undefined} highlight={highlight} />
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

function TurnCard({ turn, isLatest, view, focusMode, highlight, pinned, onPin, onApprove }: { turn: Turn; isLatest: boolean; view: TaskLogView; focusMode: boolean; highlight: string; pinned: boolean; onPin?(): void; onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null> }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = focusMode || (expanded ?? (isLatest || turn.status === "running" || turn.status === "error"));
  const waitingForApproval = turn.items.some((item) => item.kind === "approval" && item.status === "pending");

  return (
    <div id={focusMode ? focusTurnId(turn.key) : searchTurnId(turn.key)} className={`turn-card turn-card--${turn.status}`}>
      <div className="turn-card__head">
        {focusMode ? <div className="turn-card__toggle turn-card__toggle--reader">
          <span className="turn-card__cmd"><HighlightedText text={turn.command} query={highlight} /></span>
          {statusChip(turn.status, waitingForApproval)}
        </div> : <button className="turn-card__toggle" type="button" aria-expanded={open} onClick={() => setExpanded(!open)}>
          <span className="turn-card__cmd"><HighlightedText text={turn.command} query={highlight} /></span>
          {statusChip(turn.status, waitingForApproval)}
        </button>}
        {focusMode && <button type="button" className={`turn-card__pin ${pinned ? "active" : ""}`} aria-pressed={pinned} aria-label={pinned ? "取消釘選這份報告" : "釘選這份報告"} title={pinned ? "取消釘選" : "釘選報告"} onClick={onPin}>{pinned ? "★" : "☆"}</button>}
        <CopyButton value={turn.command} label="複製指令" />
      </div>
      {open && (
        <>
          <TurnItems items={turn.items} status={turn.status} view={view} focusMode={focusMode} turnKey={turn.key} highlight={highlight} onApprove={onApprove} />
          {!focusMode && turn.status !== "running" && turn.durationMs !== undefined && (
            <div className="turn-card__foot">
              {(turn.durationMs / 1000).toFixed(1)}s{turn.costUsd ? ` · $${turn.costUsd.toFixed(4)}` : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function navStatus(turn: Turn): string {
  if (turn.items.some((item) => item.kind === "approval" && item.status === "pending")) return "等待核准";
  if (turn.status === "running") return "執行中";
  if (turn.status === "error") return "失敗";
  return "完成";
}

export function QuestLog({ turns, view = "summary", searchQuery = "", focusMode = false, readerKey, onApprove }: { turns: Turn[]; view?: TaskLogView; searchQuery?: string; focusMode?: boolean; readerKey?: string; onApprove?: (approvalId: string, decision: ApprovalDecision) => Promise<string | null> }) {
  const logRef = useRef<HTMLDivElement>(null);
  const previousFocusMode = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [pinnedTurns, setPinnedTurns] = useState<Set<string>>(() => readPinnedReports(readerKey));
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK);
  const lastTurn = turns[turns.length - 1];
  const itemCount = lastTurn?.items.length ?? 0;

  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, turns.length, itemCount, lastTurn?.status, atBottom, focusMode]);

  useEffect(() => {
    const enteredFocusMode = focusMode && !previousFocusMode.current;
    previousFocusMode.current = focusMode;
    if (!enteredFocusMode) return;
    const el = logRef.current;
    if (!el) return;
    const savedTop = readerKey ? focusScrollPositions.get(readerKey) : undefined;
    const top = savedTop ?? el.scrollHeight;
    el.scrollTo({ top, behavior: "auto" });
    setAtBottom(el.scrollHeight - top - el.clientHeight < 40);
  }, [focusMode, readerKey]);

  const pending = turns.flatMap((turn) => turn.items.filter((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending"));
  const needle = searchQuery.trim().toLowerCase();
  const matchingTurns = needle ? turns.filter((turn) => searchableTurnText(turn, focusMode).toLocaleLowerCase().includes(needle)) : turns;
  const readableTurns = matchingTurns.filter((turn) => turn.items.some((item) => item.kind === "assistant_text" || item.kind === "system_error"));
  const visibleTurns = focusMode
    ? matchingTurns.filter((turn) => turn.status === "running" || readableTurns.includes(turn))
    : matchingTurns;
  // The render cap only applies while browsing normally — an active search
  // is a deliberate, infrequent action and must still be able to find (and
  // scroll to) a match anywhere in history, not just the recent window.
  const hiddenOlderCount = needle ? 0 : Math.max(0, visibleTurns.length - renderLimit);
  const renderedTurns = hiddenOlderCount > 0 ? visibleTurns.slice(hiddenOlderCount) : visibleTurns;
  const completeReportTurns = turns.filter((turn) => turn.items.some((item) => item.kind === "assistant_text" || item.kind === "system_error"));
  const searchOccurrences = needle ? visibleTurns.reduce((count, turn) => count + occurrenceCount(searchableTurnText(turn, focusMode), needle), 0) : 0;
  const navigationEntries = focusMode ? renderedTurns.flatMap((turn, turnIndex) => {
    const prefix = focusTurnId(turn.key);
    const finalItem = [...turn.items].reverse().find((item) => item.kind === "assistant_text");
    const text = finalItem && "text" in finalItem ? finalItem.text : "";
    return [
      { id: prefix, level: 0, label: turn.command, status: navStatus(turn), number: String(turnIndex + 1).padStart(2, "0"), turnKey: turn.key },
      ...extractMarkdownHeadings(text, prefix).map((heading) => ({ ...heading, status: "", number: "", turnKey: turn.key })),
    ];
  }) : [];

  useEffect(() => {
    setSearchResultIndex(0);
  }, [needle, readerKey]);

  useEffect(() => {
    setPinnedTurns(readPinnedReports(readerKey));
    setRenderLimit(RENDER_CHUNK);
  }, [readerKey]);

  function togglePinned(turnKey: string) {
    setPinnedTurns((current) => {
      const next = new Set(current);
      if (next.has(turnKey)) next.delete(turnKey);
      else next.add(turnKey);
      persistPinnedReports(readerKey, next);
      return next;
    });
  }

  function goToSearchResult(index: number) {
    if (visibleTurns.length === 0) return;
    const next = (index + visibleTurns.length) % visibleTurns.length;
    setSearchResultIndex(next);
    document.getElementById(focusMode ? focusTurnId(visibleTurns[next].key) : searchTurnId(visibleTurns[next].key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const log = (
    <div className="quest-log" ref={logRef} onScroll={() => {
      const el = logRef.current;
      if (!el) return;
      if (focusMode && readerKey) focusScrollPositions.set(readerKey, el.scrollTop);
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      if (focusMode && navigationEntries.length > 0) {
        const threshold = el.getBoundingClientRect().top + 110;
        const current = navigationEntries.reduce<string | null>((found, entry) => {
          const target = document.getElementById(entry.id);
          return target && target.getBoundingClientRect().top <= threshold ? entry.id : found;
        }, navigationEntries[0].id);
        setActiveSection(current);
      }
    }}>
      {needle && <div className="quest-log__search-results" role="status">
        <span><strong>{searchOccurrences}</strong> 處 · {visibleTurns.length} 筆任務</span>
        <div><button type="button" disabled={visibleTurns.length === 0} aria-label="上一筆搜尋結果" onClick={() => goToSearchResult(searchResultIndex - 1)}>↑</button><small>{visibleTurns.length > 0 ? `${searchResultIndex + 1}/${visibleTurns.length}` : "0/0"}</small><button type="button" disabled={visibleTurns.length === 0} aria-label="下一筆搜尋結果" onClick={() => goToSearchResult(searchResultIndex + 1)}>↓</button></div>
      </div>}
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
      {hiddenOlderCount > 0 && (
        <button type="button" className="quest-log__load-earlier" onClick={() => setRenderLimit((limit) => limit + RENDER_CHUNK)}>
          顯示更早的任務（還有 {hiddenOlderCount} 筆）
        </button>
      )}
      {renderedTurns.map((turn, i) => (
        <TurnCard key={turn.key} turn={turn} isLatest={i === renderedTurns.length - 1} view={view} focusMode={focusMode} highlight={needle} pinned={pinnedTurns.has(turn.key)} onPin={() => togglePinned(turn.key)} onApprove={onApprove} />
      ))}
      {!atBottom && <button type="button" className="quest-log__latest" onClick={() => {
        const el = logRef.current;
        el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        setAtBottom(true);
      }}>↓ 最新內容</button>}
    </div>
  );

  if (!focusMode) return log;
  return (
    <div className="focus-reader" onKeyDown={(event) => {
      if (event.key !== "Escape" || !navigationOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setNavigationOpen(false);
    }}>
      <button type="button" className="focus-report-nav__toggle" aria-expanded={navigationOpen} onClick={() => setNavigationOpen((open) => !open)}>報告導覽 <span>{renderedTurns.length}</span></button>
      <nav className={`focus-report-nav ${navigationOpen ? "focus-report-nav--open" : ""}`} aria-label="報告章節導覽">
        <header><span>REPORT INDEX</span><strong>報告導覽</strong><ReportActions markdown={reportMarkdown(completeReportTurns)} /></header>
        <div className="focus-report-nav__items">
          {navigationEntries.map((entry) => <button type="button" key={entry.id} className={`${entry.level > 0 ? `focus-report-nav__heading focus-report-nav__heading--${entry.level}` : ""} ${activeSection === entry.id ? "active" : ""}`} aria-current={activeSection === entry.id ? "location" : undefined} onClick={() => {
            document.getElementById(entry.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            setActiveSection(entry.id);
            setNavigationOpen(false);
          }}><i>{entry.level === 0 && pinnedTurns.has(entry.turnKey) ? "★" : entry.number || "·"}</i><span><strong>{entry.label}</strong>{entry.status && <small>{entry.status}</small>}</span></button>)}
          {visibleTurns.length === 0 && <p>目前沒有可導覽的報告</p>}
        </div>
      </nav>
      {log}
      <div className="focus-reader__usage-space" aria-hidden="true" />
    </div>
  );
}
