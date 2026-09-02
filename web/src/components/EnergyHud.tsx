import { useEffect, useRef, useState } from "react";
import { lang, t } from "../i18n";
import type { AccountWithAuth, ProviderId, ProviderUsageState, UsageWindow } from "../types";

type Props = {
  usage: Record<ProviderId, ProviderUsageState>;
  accountUsage?: Record<string, ProviderUsageState>;
  accounts?: AccountWithAuth[];
  onRefresh(): Promise<string | null>;
  totalCostUsd: number;
};

type FocusSubject = {
  name: string;
  provider: ProviderId;
  model: string;
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
  if (!value) return t("重置時間未提供");
  const locale = lang === "zh" ? "zh-TW" : "en-US";
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return t("重置：{time}", { time: `${date.toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` });
  }
  return t("重置：{time}", { time: value.replace(/^resets\s+/i, "") });
}

function ProviderMeter({ provider, state }: { provider: ProviderId; state: ProviderUsageState }) {
  const remaining = headline(state);
  return (
    <div className={`energy-meter energy-meter--${tone(remaining)}`} title={remaining == null ? t("尚無用量資料") : t("剩餘工作能量 {pct}%", { pct: remaining })}>
      <span>{provider === "claude" ? "CLAUDE" : "CODEX"}</span>
      <div className="energy-meter__track"><i style={{ width: `${remaining ?? 0}%` }} /></div>
      <strong>{remaining == null ? "--" : `${remaining}%`}</strong>
      {state.loading && <b aria-label={t("更新中")} title={t("背景更新中")}>·</b>}
    </div>
  );
}

function WindowRow({ window }: { window: UsageWindow }) {
  return (
    <div className={`energy-detail__window energy-detail__window--${tone(window.remainingPercent)}`} title={t("剩餘 {pct}%（已用 {used}%）", { pct: window.remainingPercent, used: window.usedPercent })}>
      <div><strong>{window.label}</strong><span>{resetCopy(window.resetsAt)}</span></div>
      <div className="energy-detail__bar"><i style={{ width: `${window.remainingPercent}%` }} /></div>
      <b>{window.remainingPercent}%</b>
    </div>
  );
}

function UsageDetails({ usage, accountUsage = {}, accounts = [] }: Pick<Props, "usage" | "accountUsage" | "accounts">) {
  return <>
    {(["claude", "codex"] as ProviderId[]).map((provider) => {
      const state = usage[provider];
      return <section key={`default-${provider}`}><h3>{provider === "claude" ? "Claude Code" : "Codex"}<small>{t("共用登入")} · {state.source === "cache" ? t("快取") : state.updatedAt ? t("即時") : t("尚無資料")}</small></h3>{state.windows.length > 0 ? state.windows.map((window) => <WindowRow key={window.id} window={window} />) : <p>{state.loading ? t("正在讀取工作能量…") : state.error || t("Provider 沒有提供用量資料")}</p>}{state.error && state.windows.length > 0 && <p className="energy-detail__error">{state.error}</p>}</section>;
    })}
    {accounts.map((account) => {
      const state = accountUsage[account.id];
      const authenticated = account.auth?.status === "authenticated";
      const label = `${account.provider === "claude" ? "Claude Code" : "Codex"} · ${account.label}`;
      const status = !authenticated ? t("尚未登入") : state?.source === "cache" ? t("快取") : state?.updatedAt ? t("即時") : t("尚無資料");
      return <section key={account.id} className="energy-detail__account"><h3>{label}<small>{status}</small></h3>{state?.windows.length ? state.windows.map((window) => <WindowRow key={window.id} window={window} />) : <p>{!authenticated ? t("尚未登入") : state?.loading ? t("正在讀取工作能量…") : state?.error || t("Provider 沒有提供用量資料")}</p>}{state?.error && state.windows.length > 0 && <p className="energy-detail__error">{state.error}</p>}</section>;
    })}
  </>;
}

export function EnergyHud({ usage, accountUsage = {}, accounts = [], onRefresh, totalCostUsd }: Props) {
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
      <button type="button" className="energy-hud__summary" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={t("查看工作能量")}>
        <span className="energy-hud__title"><i />WORK ENERGY</span>
        <ProviderMeter provider="claude" state={usage.claude} />
        <ProviderMeter provider="codex" state={usage.codex} />
        <span className="energy-hud__cost" title={t("Claude 累計花費（不含 Codex；Codex 無美元計費，以配額百分比計算）")}>
          US$ {totalCostUsd.toFixed(2)}
        </span>
      </button>
      {open && (
        <div className="energy-detail">
          <header><div><span>OFFICE POWER</span><strong>{t("帳號工作能量")}</strong></div><button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? t("更新中…") : t("重新整理")}</button></header>
          <UsageDetails usage={usage} accountUsage={accountUsage} accounts={accounts} />
          {error && <div className="energy-detail__error">{error}</div>}
          <footer>{t("每個帳號分開顯示 · Claude 累計花費 US$ {cost} · Codex 以配額百分比計費，無美元金額", { cost: totalCostUsd.toFixed(2) })}</footer>
        </div>
      )}
    </div>
  );
}

export function FocusEnergy({ usage, accountUsage = {}, accounts = [], onRefresh, totalCostUsd, open, onOpenChange, activeProvider = "claude", activeSubject, anchored = false }: Props & { open: boolean; onOpenChange(open: boolean): void; activeProvider?: ProviderId; activeSubject?: FocusSubject; anchored?: boolean }) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeRemaining = headline(usage[activeProvider]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [onOpenChange]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    setError(await onRefresh());
    setRefreshing(false);
  }

  return (
    <div ref={rootRef} className={`focus-energy ${anchored ? "focus-energy--anchored" : ""}`}>
      <button type="button" className={`focus-energy__summary ${activeRemaining !== null && activeRemaining < 15 ? "focus-energy__summary--low" : ""}`} onClick={() => onOpenChange(!open)} aria-expanded={open} aria-label={t("查看專業模式工作用量")}>
        <ProviderMeter provider={activeProvider} state={usage[activeProvider]} />
        <span className="focus-energy__more">{activeRemaining !== null && activeRemaining < 15 ? t("用量偏低") : t("全部")}</span>
        <span className="energy-hud__cost" title={t("Claude 累計花費（不含 Codex；Codex 無美元計費，以配額百分比計算）")}>
          US$ {totalCostUsd.toFixed(2)}
        </span>
      </button>
      <aside className={`focus-energy__panel ${open ? "focus-energy__panel--open" : ""} ${anchored ? "focus-energy__panel--anchored" : ""}`} aria-label={t("工作用量詳情")}>
        <header>
          <div><span>WORK ENERGY</span><strong>{t("用量與重置時間")}</strong></div>
          <div className="focus-energy__panel-actions">
            <button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? t("更新中…") : t("重新整理")}</button>
            <button type="button" className="focus-energy__close" onClick={() => onOpenChange(false)} aria-label={t("關閉工作用量詳情")}>×</button>
          </div>
        </header>
        {activeSubject && <div className="focus-energy__subject">
          <span>FOCUS SUBJECT</span>
          <strong>{activeSubject.name}</strong>
          <small>{activeSubject.provider === "claude" ? "Claude" : "Codex"} · {activeSubject.model}</small>
        </div>}
        <UsageDetails usage={usage} accountUsage={accountUsage} accounts={accounts} />
        {error && <div className="energy-detail__error">{error}</div>}
        <footer>{t("每個帳號分開顯示 · Claude 累計花費 US$ {cost} · Codex 以配額百分比計費，無美元金額", { cost: totalCostUsd.toFixed(2) })}</footer>
      </aside>
    </div>
  );
}
