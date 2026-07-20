import { useEffect, useRef, useState } from "react";
import type { ProviderId, ProviderUsageState, UsageWindow } from "../types";

type Props = {
  usage: Record<ProviderId, ProviderUsageState>;
  onRefresh(): Promise<string | null>;
};

function headline(state: ProviderUsageState): number | null {
  const shared = state.windows.filter((window) => window.scope !== "model");
  if (shared.length === 0) return null;
  return Math.min(...shared.map((window) => window.remainingPercent));
}

function tone(remaining: number | null): "good" | "warn" | "low" | "empty" {
  if (remaining == null) return "empty";
  if (remaining < 15) return "low";
  if (remaining < 40) return "warn";
  return "good";
}

function resetCopy(value: string | null): string {
  if (!value) return "重置時間未提供";
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return `重置：${date.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" })} ${date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return `重置：${value.replace(/^resets\s+/i, "")}`;
}

function ProviderMeter({ provider, state }: { provider: ProviderId; state: ProviderUsageState }) {
  const remaining = headline(state);
  return (
    <div className={`energy-meter energy-meter--${tone(remaining)}`} title={remaining == null ? "尚無用量資料" : `剩餘工作能量 ${remaining}%`}>
      <span>{provider === "claude" ? "CLAUDE" : "CODEX"}</span>
      <div className="energy-meter__track"><i style={{ width: `${remaining ?? 0}%` }} /></div>
      <strong>{remaining == null ? "--" : `${remaining}%`}</strong>
      {state.loading && <b aria-label="更新中" title="背景更新中">·</b>}
    </div>
  );
}

function WindowRow({ window }: { window: UsageWindow }) {
  return (
    <div className={`energy-detail__window energy-detail__window--${tone(window.remainingPercent)}`} title={`剩餘 ${window.remainingPercent}%（已用 ${window.usedPercent}%）`}>
      <div><strong>{window.label}</strong><span>{resetCopy(window.resetsAt)}</span></div>
      <div className="energy-detail__bar"><i style={{ width: `${window.remainingPercent}%` }} /></div>
      <b>{window.remainingPercent}%</b>
    </div>
  );
}

export function EnergyHud({ usage, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    const message = await onRefresh();
    setError(message);
    setRefreshing(false);
  }

  return (
    <div ref={rootRef} className="energy-hud">
      <button type="button" className="energy-hud__summary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="查看工作能量">
        <span className="energy-hud__title"><i />WORK ENERGY</span>
        <ProviderMeter provider="claude" state={usage.claude} />
        <ProviderMeter provider="codex" state={usage.codex} />
      </button>
      {open && (
        <div className="energy-detail">
          <header><div><span>OFFICE POWER</span><strong>全域工作能量</strong></div><button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "更新中…" : "重新整理"}</button></header>
          {(["claude", "codex"] as ProviderId[]).map((provider) => {
            const state = usage[provider];
            return <section key={provider}><h3>{provider === "claude" ? "Claude Code" : "Codex"}<small>{state.source === "cache" ? "快取" : state.updatedAt ? "即時" : "尚無資料"}</small></h3>{state.windows.length > 0 ? state.windows.map((window) => <WindowRow key={window.id} window={window} />) : <p>{state.loading ? "正在讀取工作能量…" : state.error || "Provider 沒有提供用量資料"}</p>}{state.error && state.windows.length > 0 && <p className="energy-detail__error">{state.error}</p>}</section>;
          })}
          {error && <div className="energy-detail__error">{error}</div>}
          <footer>帳號共用 · 不隨房間或 NPC 切換</footer>
        </div>
      )}
    </div>
  );
}

export function FocusEnergy({ usage, onRefresh, open, onOpenChange }: Props & { open: boolean; onOpenChange(open: boolean): void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onOpenChange]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    setError(await onRefresh());
    setRefreshing(false);
  }

  return (
    <div ref={rootRef} className="focus-energy">
      <button type="button" className="focus-energy__summary" onClick={() => onOpenChange(!open)} aria-expanded={open} aria-label="查看專心模式工作用量">
        <ProviderMeter provider="claude" state={usage.claude} />
        <ProviderMeter provider="codex" state={usage.codex} />
      </button>
      <aside className={`focus-energy__panel ${open ? "focus-energy__panel--open" : ""}`} aria-label="工作用量詳情">
        <header><div><span>WORK ENERGY</span><strong>用量與重置時間</strong></div><button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "更新中…" : "重新整理"}</button></header>
        {(["claude", "codex"] as ProviderId[]).map((provider) => {
          const state = usage[provider];
          return <section key={provider}><h3>{provider === "claude" ? "Claude Code" : "Codex"}<small>{state.source === "cache" ? "快取" : state.updatedAt ? "即時" : "尚無資料"}</small></h3>{state.windows.length > 0 ? state.windows.map((window) => <WindowRow key={window.id} window={window} />) : <p>{state.loading ? "正在讀取工作能量…" : state.error || "Provider 沒有提供用量資料"}</p>}{state.error && state.windows.length > 0 && <p className="energy-detail__error">{state.error}</p>}</section>;
        })}
        {error && <div className="energy-detail__error">{error}</div>}
        <footer>帳號共用 · 不隨 NPC 切換</footer>
      </aside>
    </div>
  );
}
