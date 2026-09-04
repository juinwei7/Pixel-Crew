import { useEffect, useRef, useState } from "react";
import type { AccountWithAuth, AutoApproveMode, ProviderAuthState, ProviderId, ProviderUsageState } from "../types";
import { BLACK_WINDOW_FONT_SIZE_MAX, BLACK_WINDOW_FONT_SIZE_MIN, blackWindowAccountValue, blackWindowAgentStartCommand, clampBlackWindowFontSize, clampWindow, destroyWorkspaceTerminalTabs, loadBlackWindowLayout, mergeDraggedWindowGeometry, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, newBlackWindow, newBlackWorkspace, parseBlackWindowAccountValue, parseBlackWindowLayout, restartBlackWindow, saveBlackWindowLayout, snapWindow, type BlackWindow, type BlackWindowAgentConfig, type BlackWindowLayout } from "../blackWindowWorkspace";
import { BlackWindowTerminal, type BlackWindowTerminalHandle } from "./BlackWindowTerminal";
import { EnergyHud } from "./EnergyHud";
import { VoiceInputButton } from "./VoiceInputButton";
import { t } from "../i18n";

type Props = { defaultWorkspacePath: string; accounts: AccountWithAuth[]; defaultAuth: Record<ProviderId, ProviderAuthState>; usage: Record<ProviderId, ProviderUsageState>; accountUsage: Record<string, ProviderUsageState>; totalCostUsd: number; onRefreshUsage(): Promise<string | null>; onOpenAccounts(provider: ProviderId): void; onPixel(): void; onProfessional(): void; muxLayoutEvent: { layout: string; version: number; seq: number } | null };
type DragState = { id: string; kind: "move" | "resize"; edge?: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"; startX: number; startY: number; window: BlackWindow };
type AdvancedDraft = { model: string; autoApproveMode: AutoApproveMode };

// Which workspace tab / window a browser tab has focused is that tab's own
// view state, not shared mux content — persisting or broadcasting it would
// drag every other open tab along on every workspace switch (and, worse,
// mount/attach that tab to whatever terminal the switch lands on).
function stripSelection(layout: BlackWindowLayout): BlackWindowLayout {
  return { ...layout, selectedWorkspaceId: null, selectedId: null };
}

function preserveLocalSelection(current: BlackWindowLayout, incoming: BlackWindowLayout): BlackWindowLayout {
  return {
    ...incoming,
    selectedWorkspaceId: incoming.workspaces.some((workspace) => workspace.id === current.selectedWorkspaceId) ? current.selectedWorkspaceId : incoming.selectedWorkspaceId,
    selectedId: incoming.windows.some((window) => window.id === current.selectedId) ? current.selectedId : incoming.selectedId,
  };
}

// Reaches the daemon directly via REST rather than a mounted pane's ref —
// a workspace being deleted is very often not the currently-viewed one, so
// its panes have no mounted BlackWindowTerminal (and thus no ref) at all.
async function destroyTerminalTab(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/terminal-mux/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}

function providerLabel(provider: ProviderId): string { return provider === "codex" ? "Codex" : "Claude"; }
function authenticated(status: ProviderAuthState["status"] | undefined): boolean { return status === "authenticated"; }

export function BlackWindowWorkspace({ defaultWorkspacePath, accounts, defaultAuth, usage, accountUsage, totalCostUsd, onRefreshUsage, onOpenAccounts, onPixel, onProfessional, muxLayoutEvent }: Props) {
  const [layout, setLayout] = useState<BlackWindowLayout>(() => loadBlackWindowLayout(defaultWorkspacePath));
  const [muxHydrated, setMuxHydrated] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [terminalStatuses, setTerminalStatuses] = useState<Record<string, "connecting" | "ready" | "closed" | "error">>({});
  const [advancedDraft, setAdvancedDraft] = useState<AdvancedDraft>({ model: "", autoApproveMode: "off" });
  const terminalRefs = useRef(new Map<string, BlackWindowTerminalHandle | null>());
  const dragRef = useRef<DragState | null>(null);
  const pendingMuxLayoutRef = useRef<Props["muxLayoutEvent"]>(null);
  // Tracks the last layout string this tab knows the server has — either what
  // it just fetched or what it just saved — so an echo of its own save (every
  // open tab receives every broadcast, including its own) is a no-op instead
  // of a redundant re-render/re-save loop.
  const lastSyncedLayoutRef = useRef<string | null>(null);
  const layoutVersionRef = useRef(0);
  const selectedWorkspace = layout.workspaces.find((workspace) => workspace.id === layout.selectedWorkspaceId) ?? layout.workspaces[0] ?? null;
  const visibleWindows = layout.windows.filter((entry) => entry.workspaceId === selectedWorkspace?.id);
  const selected = visibleWindows.find((entry) => entry.id === layout.selectedId) ?? visibleWindows.at(-1) ?? null;

  useEffect(() => {
    setAdvancedDraft({ model: selected?.model ?? "", autoApproveMode: selected?.autoApproveMode ?? "off" });
  }, [selected?.id, selected?.model, selected?.autoApproveMode]);

  const receiveMuxLayout = (event: NonNullable<Props["muxLayoutEvent"]>) => {
    if (event.layout === lastSyncedLayoutRef.current) return;
    if (dragRef.current) {
      if (!pendingMuxLayoutRef.current || event.version >= pendingMuxLayoutRef.current.version) pendingMuxLayoutRef.current = event;
      return;
    }
    pendingMuxLayoutRef.current = null;
    lastSyncedLayoutRef.current = event.layout;
    layoutVersionRef.current = event.version;
    const incoming = parseBlackWindowLayout(event.layout, defaultWorkspacePath);
    setLayout((current) => preserveLocalSelection(current, incoming));
  };

  useEffect(() => { saveBlackWindowLayout(layout); }, [layout]);
  useEffect(() => {
    let live = true;
    let attempt = 0;
    let timer: number | undefined;
    const tryHydrate = () => {
      fetch("/api/terminal-mux/layout").then(async (response) => {
        if (!response.ok) throw new Error("mux unavailable");
        return response.json() as Promise<{ layout?: unknown; version?: unknown }>;
      }).then((result) => {
        if (!live) return;
        layoutVersionRef.current = typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : 0;
        if (typeof result.layout === "string") {
          lastSyncedLayoutRef.current = result.layout;
          const incoming = parseBlackWindowLayout(result.layout, defaultWorkspacePath);
          setLayout((current) => preserveLocalSelection(current, incoming));
        }
        setMuxHydrated(true);
      }).catch(() => {
        if (!live) return;
        // The mux daemon can take a few seconds to spin up on first use; retry instead
        // of giving up, since giving up would arm the write-back effect below and let
        // this tab's empty fallback layout overwrite the daemon's real one.
        attempt += 1;
        if (attempt < 8) timer = window.setTimeout(tryHydrate, 500);
      });
    };
    tryHydrate();
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [defaultWorkspacePath]);
  useEffect(() => {
    if (!muxHydrated) return;
    const shared = stripSelection(layout);
    const serialized = JSON.stringify(shared);
    if (serialized === lastSyncedLayoutRef.current) return;
    const timer = window.setTimeout(() => {
      const expectedVersion = layoutVersionRef.current;
      void fetch("/api/terminal-mux/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: shared, expectedVersion }) })
        .then(async (response) => {
          const result = await response.json() as { layout?: unknown; version?: unknown };
          if (!response.ok) {
            if (response.status === 409 && typeof result.layout === "string" && typeof result.version === "number") {
              // Another tab saved first. Adopt its authoritative revision rather
              // than retrying this stale whole-document snapshot over it.
              receiveMuxLayout({ layout: result.layout, version: result.version, seq: -1 });
            }
            return;
          }
          lastSyncedLayoutRef.current = serialized;
          if (typeof result.version === "number") layoutVersionRef.current = result.version;
        }).catch(() => { /* The next local edit retries; retain the last confirmed revision. */ });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [layout, muxHydrated]);
  useEffect(() => {
    if (!muxLayoutEvent) return;
    receiveMuxLayout(muxLayoutEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muxLayoutEvent?.seq]);
  useEffect(() => {
    const fit = () => setLayout((current) => ({ ...current, windows: current.windows.map((entry) => entry.maximized ? entry : clampWindow(entry)) }));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const update = (id: string, patch: Partial<BlackWindow>) => setLayout((current) => ({ ...current, windows: current.windows.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) }));
  const focus = (id: string) => setLayout((current) => {
    const target = current.windows.find((entry) => entry.id === id);
    if (!target) return current;
    const z = Math.max(0, ...current.windows.map((entry) => entry.z)) + 1;
    return { ...current, selectedId: id, selectedWorkspaceId: target.workspaceId, windows: current.windows.map((entry) => entry.id === id ? { ...entry, z, minimized: false } : entry) };
  });
  const selectWorkspace = (workspaceId: string) => setLayout((current) => {
    const panes = current.windows.filter((entry) => entry.workspaceId === workspaceId);
    return { ...current, selectedWorkspaceId: workspaceId, selectedId: panes.at(-1)?.id ?? null };
  });
  const renameWorkspace = (workspaceId: string, title: string) => {
    const next = title.trim().slice(0, 48);
    if (next) setLayout((current) => ({ ...current, workspaces: current.workspaces.map((workspace) => workspace.id === workspaceId ? { ...workspace, title: next } : workspace) }));
    setEditingWorkspaceId(null);
  };
  const moveWorkspace = (sourceId: string, targetId: string) => setLayout((current) => {
    if (sourceId === targetId) return current;
    const sourceIndex = current.workspaces.findIndex((workspace) => workspace.id === sourceId);
    const targetIndex = current.workspaces.findIndex((workspace) => workspace.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return current;
    const workspaces = [...current.workspaces];
    const [source] = workspaces.splice(sourceIndex, 1);
    workspaces.splice(targetIndex, 0, source);
    return { ...current, workspaces };
  });
  const deleteWorkspace = async (workspaceId: string) => {
    const workspace = layout.workspaces.find((item) => item.id === workspaceId);
    const panes = layout.windows.filter((item) => item.workspaceId === workspaceId);
    if (!workspace) return;
    if (!window.confirm(t("刪除「{name}」與其中 {count} 個 CLI session？這無法復原。", { name: workspace.title, count: panes.length }))) return;
    const destroyed = await destroyWorkspaceTerminalTabs(panes.map((pane) => pane.id), destroyTerminalTab);
    if (!destroyed) { window.alert(t("刪除 Workspace 的 CLI 失敗，請再試一次。")); return; }
    for (const pane of panes) terminalRefs.current.delete(pane.id);
    setLayout((current) => {
      const destroyedIds = new Set(panes.map((pane) => pane.id));
      // If another tab added a pane while the deletes were in flight, retain
      // that pane and its workspace rather than making the new PTY unreachable.
      const hasConcurrentPane = current.windows.some((item) => item.workspaceId === workspaceId && !destroyedIds.has(item.id));
      const workspaces = hasConcurrentPane ? current.workspaces : current.workspaces.filter((item) => item.id !== workspaceId);
      const windows = current.windows.filter((item) => !destroyedIds.has(item.id));
      if (hasConcurrentPane) return { ...current, workspaces, windows, selectedId: current.selectedId && windows.some((item) => item.id === current.selectedId) ? current.selectedId : windows.find((item) => item.workspaceId === current.selectedWorkspaceId)?.id ?? null };
      const fallback = workspaces[0] ?? null;
      const selectedWorkspaceId = current.selectedWorkspaceId === workspaceId ? fallback?.id ?? null : current.selectedWorkspaceId;
      const selectedId = current.selectedId && windows.some((item) => item.id === current.selectedId) ? current.selectedId : windows.find((item) => item.workspaceId === selectedWorkspaceId)?.id ?? null;
      return { ...current, workspaces, windows, selectedWorkspaceId, selectedId };
    });
  };
  const addPane = () => setLayout((current) => {
    const workspace = current.workspaces.find((item) => item.id === current.selectedWorkspaceId) ?? current.workspaces[0];
    if (!workspace) return current;
    const entry = newBlackWindow(workspace.defaultWorkspacePath, current.windows.filter((item) => item.workspaceId === workspace.id).length, Math.max(0, ...current.windows.map((item) => item.z)) + 1, workspace.id);
    return { ...current, windows: [...current.windows, entry], selectedId: entry.id, selectedWorkspaceId: workspace.id };
  });
  const addWorkspace = (explicitPath?: string) => setLayout((current) => {
    const basePath = explicitPath ?? current.windows.find((entry) => entry.id === current.selectedId)?.workspacePath ?? defaultWorkspacePath;
    const workspace = newBlackWorkspace(basePath, current.workspaces.length);
    const entry = newBlackWindow(basePath, 0, Math.max(0, ...current.windows.map((item) => item.z)) + 1, workspace.id);
    return { ...current, workspaces: [...current.workspaces, workspace], windows: [...current.windows, entry], selectedWorkspaceId: workspace.id, selectedId: entry.id };
  });
  const close = (id: string) => {
    // Only drop the window once the daemon has actually confirmed the PTY is
    // gone — removing it from the layout first (like the old fire-and-forget
    // WS message did) can leave an orphaned, unreachable PTY behind if that
    // pane's socket happened to be dead or mid-reconnect at the time.
    void (terminalRefs.current.get(id)?.destroy() ?? Promise.resolve(true)).then((ok) => {
      if (!ok) { window.alert(t("關閉 CLI 失敗，請再試一次。")); return; }
      terminalRefs.current.delete(id);
      setLayout((current) => {
        const windows = current.windows.filter((entry) => entry.id !== id);
        const next = windows.find((entry) => entry.workspaceId === current.selectedWorkspaceId) ?? null;
        return { ...current, windows, selectedId: current.selectedId === id ? next?.id ?? null : current.selectedId };
      });
    });
  };
  const split = (direction: "right" | "down") => setLayout((current) => {
    const source = current.windows.find((entry) => entry.id === current.selectedId);
    if (!source || source.minimized || source.maximized) return current;
    const next = newBlackWindow(source.workspacePath, current.windows.filter((entry) => entry.workspaceId === source.workspaceId).length, Math.max(0, ...current.windows.map((entry) => entry.z)) + 1, source.workspaceId);
    const gap = 8;
    if (direction === "right") {
      const width = Math.max(MIN_WINDOW_WIDTH, Math.floor((source.width - gap) / 2));
      const sibling = clampWindow({ ...next, x: source.x + width + gap, y: source.y, width, height: source.height });
      return { ...current, windows: [...current.windows.map((entry) => entry.id === source.id ? { ...source, width } : entry), sibling], selectedId: sibling.id };
    }
    const height = Math.max(MIN_WINDOW_HEIGHT, Math.floor((source.height - gap) / 2));
    const sibling = clampWindow({ ...next, x: source.x, y: source.y + height + gap, width: source.width, height });
    return { ...current, windows: [...current.windows.map((entry) => entry.id === source.id ? { ...source, height } : entry), sibling], selectedId: sibling.id };
  });
  const beginPointer = (event: React.PointerEvent, entry: BlackWindow, kind: DragState["kind"], edge?: DragState["edge"]) => {
    event.preventDefault(); event.stopPropagation(); focus(entry.id);
    dragRef.current = { id: entry.id, kind, edge, startX: event.clientX, startY: event.clientY, window: entry };
    const move = (next: PointerEvent) => {
      const state = dragRef.current; if (!state) return;
      const dx = next.clientX - state.startX; const dy = next.clientY - state.startY;
      setLayout((current) => ({ ...current, windows: current.windows.map((item) => {
        if (item.id !== state.id || item.maximized) return item;
        if (state.kind === "move") return clampWindow({ ...state.window, x: state.window.x + dx, y: state.window.y + dy, z: Math.max(...current.windows.map((window) => window.z)) + 1 });
        const currentEdge = state.edge ?? "se";
        let x = state.window.x; let y = state.window.y; let width = state.window.width; let height = state.window.height;
        if (currentEdge.includes("e")) width += dx; if (currentEdge.includes("s")) height += dy;
        if (currentEdge.includes("w")) { width -= dx; x += dx; } if (currentEdge.includes("n")) { height -= dy; y += dy; }
        if (width < MIN_WINDOW_WIDTH) { if (currentEdge.includes("w")) x -= MIN_WINDOW_WIDTH - width; width = MIN_WINDOW_WIDTH; }
        if (height < MIN_WINDOW_HEIGHT) { if (currentEdge.includes("n")) y -= MIN_WINDOW_HEIGHT - height; height = MIN_WINDOW_HEIGHT; }
        return clampWindow({ ...item, x, y, width, height });
      }) }));
    };
    const done = () => {
      const state = dragRef.current; dragRef.current = null;
      const pending = pendingMuxLayoutRef.current;
      pendingMuxLayoutRef.current = null;
      if (state) setLayout((current) => {
        const locallyFinished = state.kind === "move"
          ? { ...current, windows: current.windows.map((entry) => entry.id === state.id ? snapWindow(entry, current.windows.filter((item) => item.workspaceId === entry.workspaceId)) : entry) }
          : current;
        if (!pending) return locallyFinished;
        lastSyncedLayoutRef.current = pending.layout;
        layoutVersionRef.current = pending.version;
        const incoming = preserveLocalSelection(locallyFinished, parseBlackWindowLayout(pending.layout, defaultWorkspacePath));
        return mergeDraggedWindowGeometry(incoming, locallyFinished, state.id);
      });
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", done);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", done);
  };
  const selectedAccount = selected?.accountId ? accounts.find((item) => item.id === selected.accountId && item.provider === selected.provider) : undefined;
  const selectedAuthStatus = selected?.provider
    ? selected?.accountSource === "managed" ? selectedAccount?.auth?.status : defaultAuth[selected.provider]?.status
    : undefined;
  const selectedAccountLabel = selected?.provider
    ? selected.accountSource === "managed"
      ? selectedAccount ? `${providerLabel(selected.provider)} · ${selectedAccount.label}` : `${providerLabel(selected.provider)} · ${t("帳號已不存在")}`
      : `${providerLabel(selected.provider)} · ${t("共用登入")}`
    : t("選擇帳號");

  const accountStatus = (provider: ProviderId, accountId: string | null): ProviderAuthState["status"] | undefined => accountId
    ? accounts.find((account) => account.id === accountId && account.provider === provider)?.auth?.status
    : defaultAuth[provider]?.status;
  const accountLabel = (provider: ProviderId, accountId: string | null): string => accountId
    ? `${providerLabel(provider)} · ${accounts.find((account) => account.id === accountId)?.label ?? t("帳號已不存在")}`
    : `${providerLabel(provider)} · ${t("共用登入")}`;

  const restartAgent = async (config: BlackWindowAgentConfig, nextLabel: string, reason: "account" | "settings" = "account"): Promise<boolean> => {
    if (!selected?.provider || restartingId) return false;
    const nextAccount = config.accountId ? accounts.find((account) => account.id === config.accountId && account.provider === config.provider) : undefined;
    const nextStatus = config.accountSource === "managed" ? nextAccount?.auth?.status : defaultAuth[config.provider!]?.status;
    if (!authenticated(nextStatus)) { onOpenAccounts(config.provider!); return false; }
    const nextEntry = { ...selected, ...config };
    if (!blackWindowAgentStartCommand(nextEntry, nextAccount)) return false;
    const confirmation = reason === "account"
      ? t("切換為「{account}」需要結束目前 Agent session 並重新啟動。確定繼續？", { account: nextLabel })
      : t("套用新的進階設定需要結束目前 Agent session 並重新啟動。確定繼續？");
    if (!window.confirm(confirmation)) return false;
    const oldId = selected.id;
    setRestartingId(oldId);
    const destroyed = await (terminalRefs.current.get(oldId)?.destroy() ?? Promise.resolve(false));
    if (!destroyed) {
      setRestartingId(null);
      window.alert(t("無法重新啟動 CLI，原本的 session 已保留。"));
      return false;
    }
    terminalRefs.current.delete(oldId);
    setLayout((current) => restartBlackWindow(current, oldId, config));
    setRestartingId(null);
    return true;
  };

  const chooseAccount = async (value: string) => {
    if (!selected) return;
    const choice = parseBlackWindowAccountValue(value);
    if (!choice) return;
    if (choice.provider === selected.provider && choice.accountSource === selected.accountSource && choice.accountId === selected.accountId) return;
    const config: BlackWindowAgentConfig = { ...choice, model: selected.model, autoApproveMode: selected.autoApproveMode };
    if (selected.agentStarted) {
      await restartAgent(config, accountLabel(choice.provider!, choice.accountId));
      return;
    }
    update(selected.id, { ...choice, title: choice.provider?.toUpperCase() ?? "CODEX" });
  };

  const launchAgent = async () => {
    if (!selected?.provider) return;
    if (!authenticated(selectedAuthStatus)) { onOpenAccounts(selected.provider); return; }
    const account = selected.accountId ? accounts.find((item) => item.id === selected.accountId) : undefined;
    const command = blackWindowAgentStartCommand(selected, account);
    if (command) {
      const launched = await terminalRefs.current.get(selected.id)?.launch(command);
      if (launched) update(selected.id, { agentStarted: true });
      else window.alert(t("Agent 無法啟動，請確認 CLI 與帳號登入狀態。"));
    }
  };

  const applyAdvanced = async () => {
    if (!selected?.provider) return;
    const config: BlackWindowAgentConfig = {
      provider: selected.provider,
      accountSource: selected.accountSource,
      accountId: selected.accountId,
      model: advancedDraft.model.trim(),
      autoApproveMode: advancedDraft.autoApproveMode,
    };
    if (selected.agentStarted) await restartAgent(config, selectedAccountLabel, "settings");
    else update(selected.id, { model: config.model, autoApproveMode: config.autoApproveMode });
  };
  return <section className="black-workspace" aria-label={t("黑窗工程工作台")}>
    <header className="black-workspace__toolbar">
      <div className="black-workspace__brand" aria-label="PIXEL CREW"><i />PIXEL CREW</div>
      <div className="black-workspace__modes" role="group" aria-label={t("工作模式")}><button onClick={onPixel}>{t("像素")}</button><button onClick={onProfessional}>{t("專業")}</button><button className="active">{t("黑窗")}</button></div>
      <EnergyHud usage={usage} accountUsage={accountUsage} accounts={accounts} onRefresh={onRefreshUsage} totalCostUsd={totalCostUsd}/>
      <div className="black-workspace__tabs">{visibleWindows.filter((entry) => entry.minimized).map((entry) => <button key={entry.id} onClick={() => focus(entry.id)}>{entry.title}</button>)}</div>
      <button type="button" className="black-workspace__new" onClick={addPane}>＋ {t("新 CLI")}</button><button type="button" onClick={() => addWorkspace()}>＋ {t("新分頁")}</button>
      <button type="button" onClick={() => split("right")} disabled={!selected || selected.minimized || selected.maximized}>{t("右切")}</button><button type="button" onClick={() => split("down")} disabled={!selected || selected.minimized || selected.maximized}>{t("下切")}</button>
      {selected && <div className="black-workspace__settings">
        <VoiceInputButton placement="toolbar" disabled={terminalStatuses[selected.id] !== "ready"} label={t("語音輸入至目前 CLI")} onTranscript={(text) => terminalRefs.current.get(selected.id)?.insertText(text)} />
        <details className="black-account-picker">
          <summary aria-label={t("切換 CLI 帳號")}><span className={authenticated(selectedAuthStatus) ? "online" : "offline"}/>{selectedAccountLabel}<b>▾</b></summary>
          <div className="black-account-picker__menu">
            {(["codex", "claude"] as ProviderId[]).map((provider) => <section key={provider}><strong>{providerLabel(provider)}</strong>
              <button type="button" aria-label={`${providerLabel(provider)} · ${t("共用登入")} · ${authenticated(accountStatus(provider, null)) ? t("已登入") : t("未登入")}`} className={blackWindowAccountValue(provider, null) === blackWindowAccountValue(selected.provider ?? "codex", selected.accountId) && selected.accountSource === "ambient" ? "active" : ""} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void chooseAccount(blackWindowAccountValue(provider, null)); }}><i className={authenticated(accountStatus(provider, null)) ? "online" : "offline"}/><span>{t("共用登入")}</span><small>{authenticated(accountStatus(provider, null)) ? t("已登入") : t("未登入")}</small></button>
              {accounts.filter((account) => account.provider === provider).map((account) => <button type="button" aria-label={`${providerLabel(provider)} · ${account.label} · ${authenticated(account.auth?.status) ? t("已登入") : t("未登入")}`} key={account.id} className={selected.accountId === account.id ? "active" : ""} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void chooseAccount(blackWindowAccountValue(provider, account.id)); }}><i className={authenticated(account.auth?.status) ? "online" : "offline"}/><span>{account.label}</span><small>{authenticated(account.auth?.status) ? t("已登入") : t("未登入")}</small></button>)}
            </section>)}
            <button type="button" className="black-account-picker__manage" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onOpenAccounts(selected.provider ?? "codex"); }}>＋ {t("管理／新增帳號")}</button>
          </div>
        </details>
        <button type="button" className="black-workspace__launch" onClick={() => void launchAgent()} disabled={Boolean(restartingId) || selected.agentStarted || terminalStatuses[selected.id] !== "ready"}>{restartingId === selected.id ? t("重新啟動中…") : selected.agentStarted ? t("Agent 運行中") : terminalStatuses[selected.id] !== "ready" ? t("正在連線…") : authenticated(selectedAuthStatus) ? t("啟動 Agent") : t("登入帳號")}</button>
        <details className="black-workspace__advanced">
          <summary aria-label={t("進階設定")}>⋯</summary>
          <div><label>{t("模型")}<input value={advancedDraft.model} onChange={(event) => setAdvancedDraft((current) => ({ ...current, model: event.target.value }))} placeholder={t("使用預設模型")}/></label><label>{t("核准模式")}<select value={advancedDraft.autoApproveMode} onChange={(event) => setAdvancedDraft((current) => ({ ...current, autoApproveMode: event.target.value as AutoApproveMode }))}><option value="off">{t("手動核准")}</option><option value="safe">{t("安全")}</option><option value="full">{t("完全")}</option><option value="invincible">{t("無限制")}</option></select></label><button type="button" disabled={Boolean(restartingId) || (advancedDraft.model.trim() === selected.model && advancedDraft.autoApproveMode === selected.autoApproveMode)} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void applyAdvanced(); }}>{selected.agentStarted ? t("套用並重新啟動") : t("儲存設定")}</button></div>
        </details>
      </div>}
    </header>
    <div className={"black-workspace__main " + (layout.railCollapsed ? "black-workspace__main--rail-collapsed" : "")}>
      <aside className={"black-workspace__rail " + (layout.railCollapsed ? "black-workspace__rail--collapsed" : "")} aria-label={t("工程工作區")}><div className="black-workspace__rail-title"><span>WORKSPACES</span><button type="button" onClick={() => setLayout((current) => ({ ...current, railCollapsed: !current.railCollapsed }))} title={layout.railCollapsed ? t("展開 Workspaces") : t("收合 Workspaces")} aria-label={layout.railCollapsed ? t("展開 Workspaces") : t("收合 Workspaces")}>{layout.railCollapsed ? "›" : "‹"}</button>{!layout.railCollapsed && <button type="button" onClick={() => addWorkspace()} title={t("新增分頁")}>＋</button>}</div>
        <div className="black-workspace__workspace-list">{layout.workspaces.map((workspace) => {
          const panes = layout.windows.filter((entry) => entry.workspaceId === workspace.id); const hasAgent = panes.some((entry) => entry.mode === "agent");
          const editing = editingWorkspaceId === workspace.id;
          return <div key={workspace.id} draggable={!editing} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", workspace.id); setDragWorkspaceId(workspace.id); }} onDragOver={(event) => { if (dragWorkspaceId && dragWorkspaceId !== workspace.id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { event.preventDefault(); const sourceId = event.dataTransfer.getData("text/plain") || dragWorkspaceId; if (sourceId) moveWorkspace(sourceId, workspace.id); setDragWorkspaceId(null); }} onDragEnd={() => setDragWorkspaceId(null)} className={"black-workspace__workspace " + (workspace.id === selectedWorkspace?.id ? "active " : "") + (dragWorkspaceId === workspace.id ? "black-workspace__workspace--dragging" : "")} title={workspace.defaultWorkspacePath}>
            <button type="button" className="black-workspace__workspace-select" onClick={() => selectWorkspace(workspace.id)}><i className={hasAgent ? "agent" : ""}/><span>{editing ? <input autoFocus value={workspaceNameDraft} aria-label={t("Workspace 名稱")} onClick={(event) => event.stopPropagation()} onChange={(event) => setWorkspaceNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") renameWorkspace(workspace.id, workspaceNameDraft); if (event.key === "Escape") setEditingWorkspaceId(null); }} onBlur={() => renameWorkspace(workspace.id, workspaceNameDraft)}/> : <strong>{workspace.title}</strong>}<small>{panes.length ? panes.length + " " + t("個 CLI") : t("尚未開啟")}</small></span></button>
            <button type="button" className="black-workspace__workspace-rename" aria-label={t("重新命名 Workspace")} onClick={() => { setEditingWorkspaceId(workspace.id); setWorkspaceNameDraft(workspace.title); }}>✎</button>
            <button type="button" className="black-workspace__workspace-delete" aria-label={t("刪除 Workspace")} onClick={() => deleteWorkspace(workspace.id)}>×</button>
          </div>;
        })}</div><footer>{t("每個分頁獨立保存 panes 與 CLI session")}</footer>
      </aside>
      <div className="black-workspace__canvas">
        {visibleWindows.map((entry) => <article key={entry.id} className={"black-window " + (entry.id === selected?.id ? "black-window--active " : "") + (entry.minimized ? "black-window--minimized" : "")} style={{ left: entry.x, top: entry.y, width: entry.width, height: entry.height, zIndex: entry.z }} onPointerDown={() => focus(entry.id)}>
          <header className="black-window__bar" onPointerDown={(event) => beginPointer(event, entry, "move")}><span className="black-window__dot"/><strong>{entry.title}</strong><code title={entry.workspacePath}>{entry.workspacePath}</code>
            <button type="button" className="black-window__font" aria-label={t("縮小終端字體")} title={`${t("縮小終端字體")} · ${entry.fontSize}px`} disabled={entry.fontSize <= BLACK_WINDOW_FONT_SIZE_MIN} onPointerDown={(event) => event.stopPropagation()} onClick={() => update(entry.id, { fontSize: clampBlackWindowFontSize(entry.fontSize - 1) })}>A−</button><button type="button" className="black-window__font" aria-label={t("放大終端字體")} title={`${t("放大終端字體")} · ${entry.fontSize}px`} disabled={entry.fontSize >= BLACK_WINDOW_FONT_SIZE_MAX} onPointerDown={(event) => event.stopPropagation()} onClick={() => update(entry.id, { fontSize: clampBlackWindowFontSize(entry.fontSize + 1) })}>A＋</button><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => terminalRefs.current.get(entry.id)?.interrupt()} title="Ctrl+C">^C</button><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => update(entry.id, { minimized: !entry.minimized })}>{entry.minimized ? "□" : "−"}</button><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => close(entry.id)}>×</button>
          </header>
          <BlackWindowTerminal ref={(node) => terminalRefs.current.set(entry.id, node)} sessionId={entry.id} workspacePath={entry.workspacePath} fontSize={entry.fontSize} launchCommand={entry.agentStarted ? blackWindowAgentStartCommand(entry, entry.accountId ? accounts.find((account) => account.id === entry.accountId) : undefined) ?? undefined : null} terminalLabel={entry.agentStarted ? entry.accountSource === "managed" && !accounts.some((account) => account.id === entry.accountId && account.provider === entry.provider) ? t("帳號不可用；請重新選擇") : t("Agent 已附掛；設定僅作用於這個 CLI") : t("Agent 尚未啟動")} active={entry.id === selected?.id} onActivate={() => focus(entry.id)} onStatus={(status) => setTerminalStatuses((current) => current[entry.id] === status ? current : { ...current, [entry.id]: status })}/>
          {!entry.maximized && !entry.minimized && (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((edge) => <i key={edge} className={"black-window__resize black-window__resize--" + edge} onPointerDown={(event) => beginPointer(event, entry, "resize", edge)}/>)}
        </article>)}
        {!visibleWindows.length && <div className="black-workspace__empty"><strong>{selectedWorkspace?.title ?? t("新的分頁")}</strong><span>{t("這個分頁尚未有 CLI。")}</span><button type="button" onClick={addPane}>＋ {t("新增 CLI")}</button></div>}
      </div>
    </div>
  </section>;
}
