import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AccountWithAuth, AutoApproveMode, CapabilityState, ProviderAuthState, ProviderId, UpdateInfo, WorkerState } from "../types";
import { APP_VERSION } from "../appVersion";
import { lang, setLang, t, tc } from "../i18n";
import { theme, setTheme } from "../theme";
import { apiRequest } from "../api";
import { roomName } from "../workspace";

type AppToggles = { brainSwapEnabled: boolean; limitResumeEnabled: boolean };

type ModelOption = { id: string; label: string; description?: string };

export function canShowBackgroundServiceStop(
  platform: string | undefined,
  onShutdown: (() => void) | undefined,
): boolean {
  return platform === "win32" && typeof onShutdown === "function";
}

type Props = {
  active?: WorkerState;
  activeWorkspace: string;
  platform?: string;
  capabilities: CapabilityState;
  auth: ProviderAuthState;
  wsReady: boolean;
  modelOptions: ModelOption[];
  workerCount: number;
  providerChanging?: boolean;
  accounts?: AccountWithAuth[];
  onSetWorkerAccount?(workerId: string, accountId: string | null): void;
  onRoom(): void;
  onBossAssignment?(): void;
  onOpenMcp(): void;
  onOpenAccounts(): void;
  onOpenBackup(): void;
  onOpenOps(): void;
  onOpenKanban(): void;
  onOpenDayReport(): void;
  onOpenOutbox(): void;
  onOpenTour(): void;
  onOpenRemote(): void;
  onRestart(): void;
  onShutdown?(): void;
  restartPending: boolean;
  onProvider(provider: ProviderId): void;
  onModel(model: string): void;
  onAutoApprove(mode: AutoApproveMode): void;
  onRefreshAuth(): void;
  onResetUi(): void;
  notificationsEnabled: boolean;
  onNotificationsToggle(): void;
  updateInfo?: UpdateInfo | null;
  /** 置中插槽（能量條）：排進 flex 流裡跟其他控件互相讓位，不再蓋住任何按鈕。 */
  children?: ReactNode;
};

export function TopBar({
  active,
  activeWorkspace,
  platform,
  capabilities,
  auth,
  wsReady,
  modelOptions,
  workerCount,
  providerChanging = false,
  accounts,
  onSetWorkerAccount,
  onRoom,
  onBossAssignment,
  onOpenMcp,
  onOpenAccounts,
  onOpenBackup,
  onOpenOps,
  onOpenKanban,
  onOpenDayReport,
  onOpenOutbox,
  onOpenTour,
  onOpenRemote,
  onRestart,
  onShutdown,
  restartPending,
  onProvider,
  onModel,
  onAutoApprove,
  onRefreshAuth,
  onResetUi,
  notificationsEnabled,
  onNotificationsToggle,
  updateInfo = null,
  children,
}: Props) {
  const [healthOpen, setHealthOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // 全域功能開關：⚙ 選單打開時才抓，改動走樂觀更新、失敗回滾。
  const [appToggles, setAppToggles] = useState<AppToggles | null>(null);
  const updateRef = useRef<HTMLDivElement>(null);
  const healthRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const provider = active?.provider ?? "claude";
  const authReady = auth.status === "authenticated";
  const connected = capabilities.mcpServers.filter((server) =>
    server.status === "connected" || server.status === "enabled"
  ).length;
  const showBackgroundServiceStop = canShowBackgroundServiceStop(platform, onShutdown);

  useEffect(() => {
    if (!toolsOpen) return;
    let cancelled = false;
    void apiRequest<{ settings: AppToggles }>("/api/app-settings")
      .then((data) => { if (!cancelled) setAppToggles(data.settings); })
      .catch(() => { /* 抓不到就維持 null，開關顯示為停用 */ });
    return () => { cancelled = true; };
  }, [toolsOpen]);

  const toggleAppSetting = (key: keyof AppToggles) => {
    if (!appToggles) return;
    const previous = appToggles;
    const next = { ...appToggles, [key]: !appToggles[key] };
    setAppToggles(next);
    void apiRequest<{ settings: AppToggles }>("/api/app-settings", { method: "POST", body: { [key]: next[key] } })
      .then((data) => setAppToggles(data.settings))
      .catch(() => setAppToggles(previous));
  };

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHealthOpen(false);
        setUpdateOpen(false);
        setToolsOpen(false);
        if (moreRef.current) moreRef.current.open = false; // 原生 <details>：手動收合
      }
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!healthRef.current?.contains(target)) setHealthOpen(false);
      if (!updateRef.current?.contains(target)) setUpdateOpen(false);
      if (!toolsRef.current?.contains(target)) setToolsOpen(false);
      // 「…」是原生 <details>，點外面不會自動關；開著且點到外面才手動收合。
      if (moreRef.current?.open && !moreRef.current.contains(target)) moreRef.current.open = false;
    };
    window.addEventListener("keydown", close);
    // 用捕獲階段：3D／像素辦公室畫布會在冒泡階段吃掉 pointerdown，冒泡監聽收不到→
    // 點畫布空白處選單不會關。捕獲是由外往內（window 先收到），保證每次點擊都能判斷。
    window.addEventListener("pointerdown", closeOutside, true);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", closeOutside, true);
    };
  }, []);

  return (
    <header className="top-bar">
      <div className="top-bar__brand"><i />PIXEL CREW</div>
      {onBossAssignment && <button type="button" className="top-bar__boss" onClick={onBossAssignment}><span>BOSS</span><strong>{t("交辦工作")}</strong></button>}
      <button className="top-bar__room" type="button" onClick={onRoom} title={activeWorkspace}>
        <span>ROOM</span>
        <strong>{roomName(activeWorkspace)}</strong>
        <b>⌄</b>
      </button>

      <div className="top-bar__spacer" />
      {children}
      <div className="top-bar__spacer" />

      <div className="top-bar__agent" aria-label="Agent 設定">
        <span className="top-bar__group-label">AGENT</span>
        <select
          className="top-bar__provider-select"
          value={provider}
          disabled={Boolean(active?.busy) || providerChanging}
          onChange={(event) => onProvider(event.target.value as ProviderId)}
          aria-label={t("選擇 Agent provider")}
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select
          className="top-bar__model-select"
          value={active?.model ?? ""}
          disabled={!active || active.busy || !authReady || modelOptions.length === 0}
          onChange={(event) => onModel(event.target.value)}
          aria-label={t("選擇模型")}
        >
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        {capabilities.loading && <span className="top-bar__agent-loading" role="status" aria-label={t("正在背景更新模型")} title={t("正在背景更新模型")}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 7.4 5" /></svg></span>}
        {active && (() => {
          const providerAccounts = accounts?.filter((account) => account.provider === provider) ?? [];
          if (providerAccounts.length === 0) return null;
          const hasHistory = active.turns.length > 0;
          const providerLabel = provider === "codex" ? "Codex" : "Claude";
          return (
          <select
            className="top-bar__provider-select"
            value={active.accountId ?? ""}
            disabled={active.busy || hasHistory}
            onChange={(event) => onSetWorkerAccount?.(active.id, event.target.value || null)}
            aria-label={t("這位 NPC 使用的 {provider} 帳號", { provider: providerLabel })}
            title={
              hasHistory
                ? t("這位 NPC 已有對話紀錄，無法切換帳號——請先清除工作階段再切換，避免默默重置 {provider} 對話記憶", { provider: providerLabel })
                : t("這位 NPC 使用的 {provider} 帳號", { provider: providerLabel })
            }
          >
            <option value="">{t("共用登入")}</option>
            {providerAccounts.map((account) => (
              <option key={account.id} value={account.id} disabled={account.auth?.status !== "authenticated"}>
                {account.label}{account.auth?.status !== "authenticated" ? t("（尚未登入）") : ""}
              </option>
            ))}
          </select>
          );
        })()}
        <select
          className={`top-bar__auto-approve top-bar__auto-approve--${active?.autoApproveMode ?? "off"}`}
          value={active?.autoApproveMode ?? "off"}
          disabled={!active}
          onChange={(event) => onAutoApprove(event.target.value as AutoApproveMode)}
          aria-label={t("自動核准模式")}
          title={t("安全：只有唯讀與驗證安全的指令跳過詢問。完全：除了 rm -rf、sudo 等高風險 shell 指令，其他都直接放行。無限制：完全不設限、永不詢問——連 rm -rf、sudo 都放行，風險自負！")}
        >
          <option value="off">{t("自動核准：關閉")}</option>
          <option value="safe">{t("安全自動核准")}</option>
          <option value="full">{t("完全自動核准")}</option>
          <option value="invincible">{t("⚡ 無限制")}</option>
        </select>
      </div>

      <div ref={toolsRef} className="top-bar__mcp">
        <button
          type="button"
          className={`top-bar__capability ${restartPending || capabilities.error ? "top-bar__capability--warn" : ""}`}
          onClick={() => { setHealthOpen(false); setToolsOpen((open) => !open); }}
          aria-expanded={toolsOpen}
          title={t("辦公室功能：MCP、看板、營運、下班、重啟、導覽")}
        >
          {restartPending ? t("⟳ 等空檔重啟中…") : t("⚙ 功能")} <strong>⌄</strong>
        </button>
        {toolsOpen && (
          <div className="top-bar__more-menu" role="menu">
            <button type="button" onClick={() => { setToolsOpen(false); onOpenMcp(); }} title={t("MCP 能力與連線狀態")}>
              {t("MCP 能力")} <strong>{capabilities.loading && capabilities.mcpServers.length === 0 ? "…" : `${connected}/${capabilities.mcpServers.length}`}</strong>
            </button>
            <button type="button" onClick={() => { setToolsOpen(false); onOpenAccounts(); }} title={t("帳號管理：管理多個 Codex／Claude 登入，個別 NPC 可指定要用哪一個")}>
              {t("🔑 帳號管理")}
            </button>
            <button type="button" onClick={() => { setToolsOpen(false); onOpenKanban(); }} title={t("任務看板：BOSS 交辦與部門 Mission 的所有卡片進度")}>
              {t("📋 任務看板")}
            </button>
            <button type="button" onClick={() => { setToolsOpen(false); onOpenOps(); }} title={t("成本日報與排程任務")}>
              {t("📊 營運面板")}
            </button>
            <button type="button" onClick={() => { setToolsOpen(false); onOpenDayReport(); }} title={t("下班報告與一日回放：今天花了多少、完成了什麼、事件時間軸")}>
              {t("🌙 下班報告")}
            </button>
            <button type="button" onClick={() => { setToolsOpen(false); onOpenOutbox(); }} title={t("成品匣：隊員完成的交付物（工作區 outbox 資料夾）集中一覽、一鍵開啟")}>
              {t("📦 成品匣")}
            </button>
            <button
              type="button"
              onClick={() => { setToolsOpen(false); onRestart(); }}
              disabled={restartPending}
              title={t("優雅重啟伺服器：等所有 NPC 空檔後自動重啟，不會打斷任何回合")}
            >
              {restartPending ? t("⟳ 等空檔重啟中…") : t("⟳ 重啟伺服器")}
            </button>
            {showBackgroundServiceStop && <button
              type="button"
              className="top-bar__menu-danger"
              onClick={() => { setToolsOpen(false); onShutdown?.(); }}
              title={t("停止 Windows 背景服務並關閉 Pixel Crew；進行中的 NPC 工作會中斷")}
            >
              {t("⏻ 關閉背景服務")}
            </button>}
            <button type="button" onClick={() => { setToolsOpen(false); onOpenTour(); }} title={t("新手導覽：讓導覽貓帶你重新認識辦公室")}>
              {t("❓ 新手導覽")}
            </button>
            <button type="button" onClick={() => { setToolsOpen(false); onOpenRemote(); }} title={t("遠端存取／手機控制：啟動轉接站，手機也能連進來操作")}>
              {t("🔗 遠端存取／手機控制")}
            </button>
            <label className="top-bar__menu-toggle" title={t("CTX 快滿時自動把工作交接給全新工作階段（170k 門檻）；關閉後交給 CLI 自行壓縮")}>
              <input
                type="checkbox"
                checked={appToggles?.brainSwapEnabled ?? true}
                disabled={!appToggles}
                onChange={() => toggleAppSetting("brainSwapEnabled")}
              />
              <span>{t("🧠 自動換腦")}</span>
            </label>
            <label className="top-bar__menu-toggle" title={t("回合撞到訂閱用量上限時，重置時間一到自動叫 NPC 繼續被中斷的工作")}>
              <input
                type="checkbox"
                checked={appToggles?.limitResumeEnabled ?? true}
                disabled={!appToggles}
                onChange={() => toggleAppSetting("limitResumeEnabled")}
              />
              <span>{t("⏰ 撞限自動續跑")}</span>
            </label>
          </div>
        )}
      </div>
      <button
        type="button"
        className="top-bar__capability"
        onClick={() => {
          const next = lang === "zh" ? "en" : "zh";
          // 先同步給 server（server 端訊息語言跟著切），成敗都照樣切前端再重載
          void apiRequest("/api/app-settings", { method: "POST", body: { lang: next } })
            .catch(() => {})
            .finally(() => setLang(next));
        }}
        title={t("切換語言")}
        aria-label={t("切換語言")}
      >
        🌐 <span className={lang === "zh" ? "top-bar__lang--on" : "top-bar__lang--off"}>中</span>
        <span className="top-bar__lang-sep">/</span>
        <span className={lang === "en" ? "top-bar__lang--on" : "top-bar__lang--off"}>EN</span>
      </button>
      <button
        type="button"
        className="top-bar__capability"
        onClick={() => setTheme(theme === "modern" ? "pixel" : "modern")}
        title={t("切換視覺主題：像素風 / 現代工作台")}
        aria-label={t("切換視覺主題")}
      >
        🎨 <span className={theme === "pixel" ? "top-bar__lang--on" : "top-bar__lang--off"}>{t("像素")}</span>
        <span className="top-bar__lang-sep">/</span>
        <span className={theme === "modern" ? "top-bar__lang--on" : "top-bar__lang--off"}>{t("現代")}</span>
      </button>

      <details className="top-bar__more" ref={moreRef}>
        <summary aria-label={t("更多 Agent 設定")}>•••</summary>
        <div className="top-bar__more-menu">
          {/* Phone-only: the standalone 🌐/🎨/🔔 icons are hidden on small screens
              (too cryptic + crowd the bar), surfaced here with clear labels. */}
          <div className="top-bar__more-mobile">
            <button type="button" onClick={() => {
              const next = lang === "zh" ? "en" : "zh";
              void apiRequest("/api/app-settings", { method: "POST", body: { lang: next } }).catch(() => {}).finally(() => setLang(next));
            }}>🌐 {lang === "zh" ? t("切換英文 EN") : t("切換中文 中")}</button>
            <button type="button" onClick={() => setTheme(theme === "modern" ? "pixel" : "modern")}>
              🎨 {theme === "modern" ? t("切換像素風") : t("切換現代風")}
            </button>
            <button type="button" onClick={onNotificationsToggle}>
              🔔 {notificationsEnabled ? t("關閉桌面通知") : t("開啟桌面通知")}
            </button>
          </div>
          <label>
            <span>{t("自動核准")}</span>
            <select
              value={active?.autoApproveMode ?? "off"}
              disabled={!active}
              onChange={(event) => onAutoApprove(event.target.value as AutoApproveMode)}
              aria-label={t("更多選單中的自動核准模式")}
            >
              <option value="off">{tc("自動核准", "關閉")}</option>
              <option value="safe">{t("安全")}</option>
              <option value="full">{t("完全")}</option>
              <option value="invincible">{t("⚡ 無限制")}</option>
            </select>
          </label>
          <button type="button" onClick={onOpenMcp}>{t("MCP 能力")} <strong>{connected}/{capabilities.mcpServers.length}</strong></button>
          {updateInfo?.updateAvailable && <a href={updateInfo.releaseUrl ?? "https://github.com/juinwei7/Pixel-Crew/releases/latest"} target="_blank" rel="noreferrer">{t("更新至 v{version}", { version: updateInfo.latestVersion ?? "" })}</a>}
        </div>
      </details>

      {updateInfo?.updateAvailable && (
        <div ref={updateRef} className="top-bar__update-wrap">
          <button
            type="button"
            className="top-bar__update"
            aria-expanded={updateOpen}
            onClick={() => { setHealthOpen(false); setUpdateOpen((open) => !open); }}
          >
            {t("⬆ 有新版 v{version}", { version: updateInfo.latestVersion ?? "" })}
          </button>
          {updateOpen && (
            <div className="update-popover">
              <strong>{t("Pixel Crew v{version} 已發布", { version: updateInfo.latestVersion ?? "" })}</strong>
              <small>{t("目前版本 v{version}", { version: updateInfo.currentVersion })}</small>
              <a href={updateInfo.releaseUrl ?? "https://github.com/juinwei7/Pixel-Crew/releases/latest"} target="_blank" rel="noreferrer">
                {t("查看 Release（打包版下載新 zip）")}
              </a>
              <small>{t("git clone 使用者更新方式：")}</small>
              <code>git pull && npm install && npm run build</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText("git pull && npm install && npm run build"); }}
              >
                {t("複製更新指令")}
              </button>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className={`top-bar__bell ${notificationsEnabled ? "top-bar__bell--on" : ""}`}
        aria-pressed={notificationsEnabled}
        aria-label={t("桌面通知")}
        title={notificationsEnabled ? t("桌面通知：開啟（任務完成、等待核准時通知）") : t("桌面通知：關閉")}
        onClick={onNotificationsToggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>
      </button>

      <div ref={healthRef} className="top-bar__health-wrap">
        <button
          type="button"
          className="top-bar__health"
          onClick={() => setHealthOpen((open) => !open)}
          aria-expanded={healthOpen}
          aria-label={t("查看系統健康狀態")}
        >
          <i className={`health-dot health-dot--${authReady ? "ok" : auth.status === "checking" ? "checking" : "warn"}`} />
          <i className={`health-dot health-dot--${wsReady ? "ok" : "error"}`} />
          {!authReady && auth.status !== "checking" && <span>{t("需要處理")}</span>}
        </button>
        {healthOpen && (
          <div className="health-popover">
            <div><i className={`health-dot health-dot--${authReady ? "ok" : "warn"}`} /><span>{auth.displayName}</span><strong>{authReady ? t("已就緒") : auth.status === "checking" ? t("檢查中") : t("需要登入")}</strong></div>
            <div><i className={`health-dot health-dot--${wsReady ? "ok" : "error"}`} /><span>Local server</span><strong>{wsReady ? t("已連線") : t("重新連線中")}</strong></div>
            {!authReady && <button type="button" onClick={onRefreshAuth}>{t("重新檢查")}</button>}
            <button type="button" className="health-popover__secondary" onClick={() => { onResetUi(); setHealthOpen(false); }}>{t("重設介面配置")}</button>
            <button type="button" className="health-popover__secondary" onClick={() => { onOpenBackup(); setHealthOpen(false); }}>{t("備份與還原")}</button>
            <small className="health-popover__version">
              Pixel Crew v{updateInfo?.currentVersion ?? APP_VERSION}
              {updateInfo?.updateAvailable ? t("（最新 v{version}）", { version: updateInfo.latestVersion ?? "" }) : ""}
            </small>
          </div>
        )}
      </div>
    </header>
  );
}
