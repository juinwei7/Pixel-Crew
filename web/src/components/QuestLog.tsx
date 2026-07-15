import { useEffect, useRef, useState } from "react";
import type { ToolCallItem, Turn, TurnItem } from "../types";
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

function ToolRow({ item }: { item: ToolCallItem }) {
  const [open, setOpen] = useState(false);
  const { label, mcpServer } = toolMeta(item.name);

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
          <div className="tool-row__label">INPUT</div>
          <pre>{formatValue(item.input)}</pre>
          {item.status === "done" && (
            <>
              <div className="tool-row__label">OUTPUT</div>
              <pre>{formatValue(item.output)}</pre>
            </>
          )}
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

function TurnItems({ items }: { items: TurnItem[] }) {
  return (
    <div className="turn-card__items">
      {items.map((item) => {
        if (item.kind === "tool_call") return <ToolRow key={item.key} item={item} />;
        if (item.kind === "thinking") return <ThinkingRow key={item.key} text={item.text} />;
        if (item.kind === "system_error") {
          return (
            <div key={item.key} className="turn-error">
              ✕ {item.text}
            </div>
          );
        }
        return (
          <div key={item.key} className="turn-text">
            <RichText text={item.text} />
          </div>
        );
      })}
    </div>
  );
}

function statusChip(status: Turn["status"]) {
  if (status === "running") return <span className="turn-chip turn-chip--running">進行中</span>;
  if (status === "error") return <span className="turn-chip turn-chip--error">失敗</span>;
  return <span className="turn-chip turn-chip--done">完成</span>;
}

function TurnCard({ turn, isLatest }: { turn: Turn; isLatest: boolean }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? (isLatest || turn.status === "running" || turn.status === "error");

  return (
    <div className={`turn-card turn-card--${turn.status}`}>
      <button className="turn-card__head" onClick={() => setExpanded(!open)}>
        <span className="turn-card__cmd">{turn.command}</span>
        {statusChip(turn.status)}
      </button>
      {open && (
        <>
          <TurnItems items={turn.items} />
          {turn.status !== "running" && turn.durationMs !== undefined && (
            <div className="turn-card__foot">
              {(turn.durationMs / 1000).toFixed(1)}s · ${turn.costUsd?.toFixed(4) ?? "0"}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function QuestLog({ turns }: { turns: Turn[] }) {
  const logRef = useRef<HTMLDivElement>(null);
  const lastTurn = turns[turns.length - 1];
  const itemCount = lastTurn?.items.length ?? 0;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns.length, itemCount, lastTurn?.status]);

  return (
    <div className="quest-log" ref={logRef}>
      {turns.length === 0 && (
        <div className="quest-log__empty">
          在下面下指令,例如「幫我完成工作」——小人會去任務板查還沒做完的事。
          <br />
          輸入 <code>/</code> 可以看可用的斜線指令。
        </div>
      )}
      {turns.map((turn, i) => (
        <TurnCard key={turn.key} turn={turn} isLatest={i === turns.length - 1} />
      ))}
    </div>
  );
}
