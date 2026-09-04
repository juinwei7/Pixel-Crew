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

function headline(state?: ProviderUsageState): number | null {
  const shared = state?.windows.filter((window) => window.scope !== "model") ?? [];
  if (shared.length === 0) return null;
  return Math.min(...shared.map((window) => window.remainingPercent));
}

function lowestRemaining(state?: ProviderUsageState): number | null {
  const windows = state?.windows ?? [];
  if (windows.length === 0) return null;
  return Math.min(...windows.map((window) => window.remainingPercent));
}

function tone(remaining: number | null): "good" | "warn" | "low" | "empty" {
  if (remaining == null) return "empty";
  if (remaining < 15) return "low";
  if (remaining < 40) return "warn";
  return "good";
}

// A provider's own CLI text ("resets Sep 4 at 2:10pm (Asia/Taipei)") isn't
// safe to re-parse — CLI output shape is empirical, not a stable contract —
// so only a real ISO instant (Codex's resetsAt) gets reformatted here. It's
// deliberately written in the same "Mon D at H:MMam" cadence Claude's own
// text already uses, so the two providers don't read as two conventions.
function formatResetInstant(date: Date): string {
  if (lang === "zh") {
    return t("{month} 月 {day} 日 {time}", {
      month: date.getMonth() + 1,
      day: date.getDate(),
      time: date.toLocaleTimeString("zh-TW", { hour: "numeric", minute: "2-digit", hour12: true }),
    });
  }
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", "").toLowerCase();
  return `${day} at ${time}`;
}

function resetCopy(value: string | null): string {
  if (!value) return t("重置時間未提供");
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return t("重置：{time}", { time: formatResetInstant(date) });
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

function sourceLabel(state: ProviderUsageState | undefined): string {
  if (!state) return t("尚無資料");
  return state.source === "cache" ? t("快取") : state.updatedAt ? t("即時") : t("尚無資料");
}

type AccountRowData = {
  key: string;
  name: string;
  statusLabel: string;
  state: ProviderUsageState | undefined;
  authenticated: boolean;
};

// The shared/ambient login is not a special case — it's simply this
// provider's first account row, using the exact same component as any named
// Pixel Crew account below it (see the redesign brief: these used to be two
// visually different block styles for what is structurally the same thing).
function buildAccountRows(provider: ProviderId, usage: Props["usage"], accountUsage: NonNullable<Props["accountUsage"]>, accounts: NonNullable<Props["accounts"]>): AccountRowData[] {
  const shared: AccountRowData = {
    key: `shared-${provider}`,
    name: t("共用登入"),
    statusLabel: `${t("系統終端登入")} · ${sourceLabel(usage[provider])}`,
    state: usage[provider],
    authenticated: true,
  };
  const named = accounts.filter((account) => account.provider === provider).map((account) => {
    const authenticated = account.auth?.status === "authenticated";
    return {
      key: account.id,
      name: account.label,
      statusLabel: authenticated ? `${t("Pixel Crew 帳號")} · ${sourceLabel(accountUsage[account.id])}` : t("尚未登入"),
      state: accountUsage[account.id],
      authenticated,
    };
  });
  return [shared, ...named];
}

function MeterChip({ window }: { window: UsageWindow }) {
  return (
    <span className={`energy-account__chip energy-account__chip--${tone(window.remainingPercent)}`} title={t("剩餘 {pct}%（已用 {used}%）", { pct: window.remainingPercent, used: window.usedPercent })}>
      <span className="energy-account__chip-label">{window.label}</span>
      <span className="energy-account__chip-track"><i style={{ width: `${window.remainingPercent}%` }} /></span>
      <span className="energy-account__chip-pct">{window.remainingPercent}%</span>
    </span>
  );
}

function DetailRow({ window }: { window: UsageWindow }) {
  return (
    <div className={`energy-account__detail-row energy-account__detail-row--${tone(window.remainingPercent)}`}>
      <span className="energy-account__detail-name">{window.label}</span>
      <span className="energy-account__detail-reset">{resetCopy(window.resetsAt)}</span>
      <b>{window.remainingPercent}%</b>
    </div>
  );
}

// Windows sort worst-first within a row so the one number that actually
// needs attention is always the leftmost chip, whether collapsed or open.
function AccountRow({ row }: { row: AccountRowData }) {
  const windows = [...(row.state?.windows ?? [])].sort((a, b) => a.remainingPercent - b.remainingPercent);
  const empty = !row.authenticated || windows.length === 0;
  const railTone = row.authenticated ? tone(lowestRemaining(row.state)) : "empty";
  const emptyCopy = !row.authenticated ? t("尚未登入") : row.state?.loading ? t("正在讀取工作能量…") : row.state?.error || t("Provider 沒有提供用量資料");
  return (
    <details className="energy-account">
      <summary>
        <span className={`energy-account__rail energy-account__rail--${railTone}`} aria-hidden="true" />
        <span className="energy-account__id"><strong>{row.name}</strong><span>{row.statusLabel}</span></span>
        <span className="energy-account__chips">
          {empty ? <span className="energy-account__empty">{emptyCopy}</span> : windows.map((window) => <MeterChip key={window.id} window={window} />)}
        </span>
        <span className="energy-account__chevron" aria-hidden="true">▸</span>
      </summary>
      {!empty && <div className="energy-account__detail">
        {row.state?.error && <p className="energy-detail__error">{row.state.error}</p>}
        {windows.map((window) => <DetailRow key={window.id} window={window} />)}
      </div>}
    </details>
  );
}

// The one thing worth seeing before expanding anything: across every
// account on every provider, which windows are actually running low.
function GlanceStrip({ entries }: { entries: Array<{ provider: ProviderId; row: AccountRowData }> }) {
  const items = entries
    .map(({ provider, row }) => ({ provider, row, remaining: row.authenticated ? lowestRemaining(row.state) : null }))
    .filter((entry): entry is typeof entry & { remaining: number } => entry.remaining !== null)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 4);
  if (!items.length) return null;
  return (
    <div className="energy-glance">
      {items.map(({ provider, row, remaining }) => (
        <span key={`${provider}-${row.key}`} className={`energy-glance__chip energy-glance__chip--${tone(remaining)}`}>
          <i aria-hidden="true" />{row.name === t("共用登入") ? (provider === "claude" ? "Claude" : "Codex") : row.name}
          <strong>{remaining}%</strong>
        </span>
      ))}
    </div>
  );
}

function UsageDetails({ usage, accountUsage = {}, accounts = [] }: Pick<Props, "usage" | "accountUsage" | "accounts">) {
  const grouped = (["claude", "codex"] as ProviderId[]).map((provider) => ({ provider, rows: buildAccountRows(provider, usage, accountUsage, accounts) }));
  const entries = grouped.flatMap(({ provider, rows }) => rows.map((row) => ({ provider, row })));
  return <>
    <GlanceStrip entries={entries} />
    {grouped.map(({ provider, rows }) => (
      <section key={provider} className="energy-provider">
        <h3 className="energy-provider__label">
          {provider === "claude" ? "Claude Code" : "Codex"}
          {rows.length > 1 && <small>· {t("{n} 個帳號", { n: rows.length })}</small>}
        </h3>
        {rows.map((row) => <AccountRow key={row.key} row={row} />)}
      </section>
    ))}
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
          <footer>{t("依剩餘量由低到高排序 · Claude 累計花費 US$ {cost} · Codex 以配額百分比計費，無美元金額", { cost: totalCostUsd.toFixed(2) })}</footer>
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
        <footer>{t("依剩餘量由低到高排序 · Claude 累計花費 US$ {cost} · Codex 以配額百分比計費，無美元金額", { cost: totalCostUsd.toFixed(2) })}</footer>
      </aside>
    </div>
  );
}
