import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode, type Ref } from "react";
import type { AccountWithAuth, AutoApproveMode, CapabilityState, ProviderAuthState, ProviderId, UpdateInfo, WorkerState } from "../types";
import { APP_VERSION } from "../appVersion";
import { lang, setLang, t, tc } from "../i18n";
import { apiRequest } from "../api";
import { roomName } from "../workspace";

/* 頂欄的收合階梯，由窄到更窄。TopBar 量到內容溢出就往下加一階；每一階的
   規則寫在 styles/composer-and-operations.css。收掉的東西都還在 ••• 選單裡。 */
const TOP_BAR_COMPACT_LEVELS = ["top-bar--compact", "top-bar--compact-2"] as const;
import { Icon } from "./Icon";
import { ModeSwitch, modeIndex } from "./ModeSwitch";

type AppToggles = { brainSwapEnabled: boolean; limitResumeEnabled: boolean; diagnosticsEnabled: boolean };

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
  /** 全域「執行中」NPC 數（不分工作區）；頂欄燈號用。 */
  runningCount: number;
  /** 目前正在背景執行、還沒回報的 NPC（點「在跑」燈號展開清單、可跳過去看）；subAgents 是該
      NPC 內部再拆出去、還在跑的子代理。 */
  runningWorkers?: Array<{ id: string; name: string; room: string; subAgents?: Array<{ id: string; label: string }> }>;
  onSelectRunning?(id: string): void;
  providerChanging?: boolean;
  accounts?: AccountWithAuth[];
  onSetWorkerAccount?(workerId: string, accountId: string | null): void;
  onRoom(): void;
  onBossAssignment?(): void;
  onOpenMcp(): void;
  onOpenGlobalMemory(): void;
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
  onApplyUpdate?(): void;
  updateApplying?: boolean;
  professionalMode?: boolean;
  onProfessionalModeChange?(enabled: boolean): void;
  blackWindowMode?: boolean;
  onBlackWindowModeChange?(enabled: boolean): void;
  topBarRef?: Ref<HTMLElement>;
  professionalModeButtonRef?: Ref<HTMLButtonElement>;
  onOpenCodexCommands?(): void;
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
  runningCount,
  runningWorkers = [],
  onSelectRunning,
  providerChanging = false,
  accounts,
  onSetWorkerAccount,
  onRoom,
  onBossAssignment,
  onOpenMcp,
  onOpenGlobalMemory,
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
  onApplyUpdate,
  updateApplying = false,
  professionalMode = false,
  onProfessionalModeChange,
  blackWindowMode = false,
  onBlackWindowModeChange,
  topBarRef,
  professionalModeButtonRef,
  onOpenCodexCommands,
  children,
}: Props) {
  const [healthOpen, setHealthOpen] = useState(false);
  const [runningOpen, setRunningOpen] = useState(false);
  const runningRef = useRef<HTMLDivElement>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  // 全域功能開關：平台選單打開時才抓，改動走樂觀更新、失敗回滾。
  const [moreOpen, setMoreOpen] = useState(false);
  const [appToggles, setAppToggles] = useState<AppToggles | null>(null);
  const updateRef = useRef<HTMLDivElement>(null);
  const healthRef = useRef<HTMLDivElement>(null);
  // 兩個選單都是原生 <details>：不必自己管開關狀態，內容也永遠在 DOM 裡
  // （web 測試沒有 jsdom，點不下去——只有靜態輸出看得到的東西測得到）。
  const npcRef = useRef<HTMLDetailsElement>(null);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const menuRefs = [npcRef, moreRef];
  const provider = active?.provider ?? "claude";
  const authReady = auth.status === "authenticated";
  const connected = capabilities.mcpServers.filter((server) =>
    server.status === "connected" || server.status === "enabled"
  ).length;
  const showBackgroundServiceStop = canShowBackgroundServiceStop(platform, onShutdown);
  const providerAccounts = accounts?.filter((account) => account.provider === provider) ?? [];
  const providerLabel = provider === "codex" ? "Codex" : "Claude";
  const hasHistory = Boolean(active && active.turns.length > 0);

  const providerSelect = (className = "top-bar__provider-select") => (
    <select
      className={className}
      value={provider}
      disabled={Boolean(active?.busy) || providerChanging}
      onChange={(event) => onProvider(event.target.value as ProviderId)}
      aria-label={t("選擇 Agent provider")}
    >
      <option value="claude">Claude Code</option>
      <option value="codex">Codex</option>
    </select>
  );

  const modelSelect = (className = "top-bar__model-select") => (
    <select
      className={className}
      value={active?.model ?? ""}
      disabled={!active || active.busy || !authReady || modelOptions.length === 0}
      onChange={(event) => onModel(event.target.value)}
      aria-label={t("選擇模型")}
    >
      {modelOptions.map((option) => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  );

  const accountSelect = (className = "top-bar__provider-select") => {
    if (!active || providerAccounts.length === 0) return null;
    return <select
      className={className}
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
    </select>;
  };

  useEffect(() => {
    if (!moreOpen) return;
    let cancelled = false;
    void apiRequest<{ settings: AppToggles }>("/api/app-settings")
      .then((data) => { if (!cancelled) setAppToggles(data.settings); })
      .catch(() => { /* 抓不到就維持 null，開關顯示為停用 */ });
    return () => { cancelled = true; };
  }, [moreOpen]);

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
        setRunningOpen(false);
        for (const menu of menuRefs) if (menu.current) menu.current.open = false; // 原生 <details>：手動收合
      }
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!healthRef.current?.contains(target)) setHealthOpen(false);
      if (!updateRef.current?.contains(target)) setUpdateOpen(false);
      if (!runningRef.current?.contains(target)) setRunningOpen(false);
      // 原生 <details> 點外面不會自動關；開著且點到外面才手動收合。
      for (const menu of menuRefs) {
        if (menu.current?.open && !menu.current.contains(target)) menu.current.open = false;
      }
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

  const accountMenuSelect = accountSelect("top-bar__provider-select");
  const closeMenus = () => { for (const menu of menuRefs) if (menu.current) menu.current.open = false; };

  /* 這條 bar 要多寬取決於「文字有多長」——中英文標籤長度差一截，房間名、
     模型名也都是變數。用固定的 media query 門檻去猜，永遠會在某個組合下
     猜錯：猜寬了平白收掉控件，猜窄了 flex 就去壓縮下拉，把「Claude Code」
     裁成「aude Code」。改成直接量：拿掉收合、看內容是否超出，再決定要不要
     收。這也是為什麼 bar 裡的東西一律 flex: 0 0 auto——它們必須誠實地撐出
     自己的寬度，量出來的溢出才有意義。 */
  const barRef = useRef<HTMLElement | null>(null);
  const attachBar = useCallback((node: HTMLElement | null) => {
    barRef.current = node;
    if (typeof topBarRef === "function") topBarRef(node);
    else if (topBarRef && typeof topBarRef === "object") (topBarRef as MutableRefObject<HTMLElement | null>).current = node;
  }, [topBarRef]);

  const publishedHeight = useRef(0);
  const frameRef = useRef(0);
  const measureBar = useCallback(() => {
    frameRef.current = 0;
    const el = barRef.current;
    if (!el) return;
    // 從「完全不收」開始，一階一階收到塞得下為止。每一階都嚴格變窄，
    // 所以一定會收斂；真的到最後一階還是不夠，就維持最省的樣子。
    el.classList.remove(...TOP_BAR_COMPACT_LEVELS);
    for (const level of TOP_BAR_COMPACT_LEVELS) {
      if (el.scrollWidth <= el.clientWidth + 1) break;
      el.classList.add(level);
    }
    // 手機的 dock、選單、toast 都要知道頂欄佔掉多高。量出來寫進 --top-bar-h，
    // 就不必猜「中文兩排 104、英文兩排 110、320px 三排…」。只在真的變了才寫：
    // 每幀無條件寫一次會讓瀏覽器永遠有待處理的樣式變更，畫面等於一直不穩定。
    const height = Math.round(el.getBoundingClientRect().height);
    if (height === publishedHeight.current) return;
    publishedHeight.current = height;
    document.documentElement.style.setProperty("--top-bar-h", `${height}px`);
  }, []);
  const scheduleMeasure = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(measureBar);
  }, [measureBar]);

  // 視窗變寬變窄：交給 ResizeObserver，只建一次。
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    measureBar();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(el);
    return () => { observer.disconnect(); if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [measureBar, scheduleMeasure]);

  // 內容變長變短（切語言、換模型名、出現更新提示）：bar 本身的尺寸沒變，
  // observer 不會叫，所以每次 render 後補量一次。rAF 會把同一幀的多次呼叫併成一次。
  useEffect(scheduleMeasure);

  return (
    <header ref={attachBar} className="top-bar">
      <div className="top-bar__brand"><i />PIXEL CREW</div>
      <ModeSwitch
        current={modeIndex(professionalMode, blackWindowMode)}
        onSelect={(index) => {
          // 呼叫順序照舊：先關黑窗再設專業，反過來會有一瞬間兩個都開著。
          if (index === 2) { onBlackWindowModeChange?.(true); return; }
          onBlackWindowModeChange?.(false);
          onProfessionalModeChange?.(index === 1);
        }}
        professionalModeButtonRef={professionalModeButtonRef}
      />
      {onBossAssignment && <button type="button" className="top-bar__boss" onClick={onBossAssignment}><span>BOSS</span><strong>{t("交辦工作")}</strong></button>}
      {/* 全域「在跑」燈號：不分工作區顯示目前有幾個 NPC 正在執行，讓你在聊天／別的
          工作區時也能一眼看到背景是否還有 NPC 在跑；0 時暗掉並顯示「待命」。 */}
      <div className="top-bar__running-wrap" ref={runningRef}>
        <button
          type="button"
          className={`top-bar__running ${runningCount > 0 ? "top-bar__running--on" : ""}`}
          disabled={runningCount === 0}
          aria-expanded={runningOpen}
          onClick={() => setRunningOpen((open) => !open)}
          title={runningCount > 0
            ? t("目前有 {count} 位 NPC 正在背景執行——點開看是誰", { count: runningCount })
            : t("目前沒有 NPC 在執行，全部待命中")}
          aria-label={runningCount > 0
            ? t("目前有 {count} 位 NPC 正在執行", { count: runningCount })
            : t("目前沒有 NPC 在執行，全部待命中")}
        >
          <i className="top-bar__running-dot" aria-hidden="true" />
          {runningCount > 0
            ? <><strong>{runningCount}</strong><span>{t("在跑")}</span></>
            : <span>{t("待命")}</span>}
        </button>
        {runningOpen && runningWorkers.length > 0 && (
          <div className="top-bar__running-menu" role="menu">
            <div className="top-bar__running-menu-title">{t("背景執行中（點一位跳過去看）")}</div>
            {runningWorkers.map((worker) => (
              <div key={worker.id} className="top-bar__running-group">
                <button
                  type="button"
                  role="menuitem"
                  className="top-bar__running-item"
                  onClick={() => { onSelectRunning?.(worker.id); setRunningOpen(false); }}
                >
                  <span className="top-bar__running-item-dot" aria-hidden="true" />
                  <span className="top-bar__running-item-name">{worker.name}</span>
                  <span className="top-bar__running-item-room">{worker.room}</span>
                </button>
                {(worker.subAgents ?? []).map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    role="menuitem"
                    className="top-bar__running-subitem"
                    title={sub.label}
                    onClick={() => { onSelectRunning?.(worker.id); setRunningOpen(false); }}
                  >
                    <span className="top-bar__running-subdot" aria-hidden="true" />
                    <span className="top-bar__running-subtag">{t("子代理")}</span>
                    <span className="top-bar__running-item-name">{sub.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="top-bar__spacer" />
      {children}
      <div className="top-bar__spacer" />

      {/* 頂欄只留重點，其餘收進兩個選單。分法是「作用範圍」，不是「常不常用」：
          NPC 設定只動目前選到的那一位，平台設定跟選到誰無關。之前兩邊的內容
          各自長歪（工具選單有備份沒有、••• 有備份沒有三個開關），合併成這兩份
          之後就只有一份來源。 */}
      <details className="top-bar__npc" ref={npcRef}>
        <summary
          className={`top-bar__capability ${capabilities.error ? "top-bar__capability--warn" : ""}`}
          aria-label={t("NPC 設定")}
          title={t("只作用在目前這位 NPC：供應商、模型、帳號、自動核准、MCP 能力")}
        >
          <Icon name="user" />{t("NPC 設定")}
        </summary>
        <div className="top-bar__more-menu" role="group" aria-label={t("NPC 設定")}>
            <p className="top-bar__menu-scope">{active ? t("套用於 {name}", { name: active.name }) : t("先選一位 NPC")}</p>
            <button type="button" className="top-bar__menu-room" title={activeWorkspace} onClick={() => { closeMenus(); onRoom(); }}>
              <Icon name="building" />{t("工作位置")}<strong>{roomName(activeWorkspace)}</strong>
            </button>
            <label><span>{t("供應商")}</span>{providerSelect()}</label>
            <label>
              {/* 轉圈跟在「模型」兩個字旁邊，不要當成第三個 grid 項目——那會自己
                  佔掉一整列，看起來像沒對齊的孤兒。 */}
              <span>
                {t("模型")}
                {capabilities.loading && <i className="top-bar__agent-loading" role="status" aria-label={t("正在背景更新模型")} title={t("正在背景更新模型")}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 7.4 5" /></svg></i>}
              </span>
              {modelSelect("top-bar__model-select top-bar__menu-model-select")}
            </label>
            {accountMenuSelect && <label><span>{t("帳號")}</span>{accountMenuSelect}</label>}
            <label>
              <span>{t("自動核准")}</span>
              <select
                className={`top-bar__auto-approve top-bar__auto-approve--${active?.autoApproveMode ?? "off"}`}
                value={active?.autoApproveMode ?? "off"}
                disabled={!active}
                onChange={(event) => onAutoApprove(event.target.value as AutoApproveMode)}
                aria-label={t("自動核准模式")}
                title={t("安全：只有唯讀與驗證安全的指令跳過詢問。完全：除了已辨識的高風險 Bash 指令，檔案變更、MCP 動作與其他指令都會直接放行。無限制：完全不設限、永不詢問——連 rm -rf、sudo 都放行，風險自負！")}
              >
                <option value="off">{tc("自動核准", "關閉")}</option>
                <option value="safe">{t("安全")}</option>
                <option value="full">{t("完全")}</option>
                <option value="invincible">{t("無限制")}</option>
              </select>
            </label>
            {active?.autoApproveMode === "invincible" && <button
              type="button"
              className="top-bar__auto-approve-reset"
              onClick={() => onAutoApprove("safe")}
              title={t("立即回到安全自動核准")}
            ><Icon name="shield" />{t("回到安全")}</button>}
            <div className="top-bar__menu-group">
              <button type="button" onClick={() => { closeMenus(); onOpenMcp(); }} title={t("MCP 能力與連線狀態")}>
                <Icon name="wrench" />{t("MCP 能力")}<strong>{capabilities.loading && capabilities.mcpServers.length === 0 ? "…" : `${connected}/${capabilities.mcpServers.length}`}</strong>
              </button>
              {onOpenCodexCommands && active?.provider === "codex" && <button type="button" onClick={() => { closeMenus(); onOpenCodexCommands(); }} title={t("管理 Codex CLI 的原生指令與能力")}>
                <Icon name="code" />{t("Codex 原生指令管理")}
            </button>}
          </div>
        </div>
      </details>

      <details className="top-bar__more" ref={moreRef} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
        <summary className="top-bar__capability" aria-label={t("平台設定")} title={t("整個 app 的設定：語言、通知、看板、營運、備份、重啟")}><Icon name="gear" />{t("平台設定")}</summary>
        <div className="top-bar__more-menu">
          <div className="top-bar__menu-group">
            <button type="button" onClick={() => {
              const next = lang === "zh" ? "en" : "zh";
              void apiRequest("/api/app-settings", { method: "POST", body: { lang: next } }).catch(() => {}).finally(() => setLang(next));
            }}><Icon name="globe" />{lang === "zh" ? t("切換英文 EN") : t("切換中文 中")}</button>
            <button type="button" onClick={onNotificationsToggle}>
              <Icon name="bell" />{notificationsEnabled ? t("關閉桌面通知") : t("開啟桌面通知")}
            </button>
          </div>
          <div className="top-bar__menu-group top-bar__more-compact-features">
            <button type="button" onClick={() => { closeMenus(); onOpenGlobalMemory(); }} title={t("跨所有 NPC 共用的長期記憶")}>
              <Icon name="brain" />{t("全域記憶")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenAccounts(); }} title={t("帳號管理：管理多個 Codex／Claude 登入，個別 NPC 可指定要用哪一個")}>
              <Icon name="key" />{t("帳號管理")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenKanban(); }} title={t("任務看板：BOSS 交辦與部門 Mission 的所有卡片進度")}>
              <Icon name="board" />{t("任務看板")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenOps(); }} title={t("成本日報與排程任務")}>
              <Icon name="chart" />{t("營運面板")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenDayReport(); }} title={t("下班報告與一日回放：今天花了多少、完成了什麼、事件時間軸")}>
              <Icon name="moon" />{t("下班報告")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenOutbox(); }} title={t("成品匣：隊員完成的交付物（工作區 outbox 資料夾）集中一覽、一鍵開啟")}>
              <Icon name="box" />{t("成品匣")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenBackup(); }} title={t("備份與還原：把整個辦公室打包帶走，或從備份還原")}>
              <Icon name="archive" />{t("備份與還原")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenRemote(); }} title={t("遠端存取／手機控制：啟動轉接站，手機也能連進來操作")}>
              <Icon name="link" />{t("遠端存取／手機控制")}
            </button>
            <button type="button" onClick={() => { closeMenus(); onOpenTour(); }} title={t("新手導覽：讓導覽貓帶你重新認識辦公室")}>
              <Icon name="help" />{t("新手導覽")}
            </button>
            <button
              type="button"
              disabled={restartPending}
              onClick={() => { closeMenus(); onRestart(); }}
              title={t("優雅重啟伺服器：等所有 NPC 空檔後自動重啟，不會打斷任何回合")}
            >
              <Icon name="refresh" />{restartPending ? t("等空檔重啟中…") : t("重啟伺服器")}
            </button>
            {showBackgroundServiceStop && <button
              type="button"
              className="top-bar__menu-danger"
              onClick={() => { closeMenus(); onShutdown?.(); }}
              title={t("停止 Windows 背景服務並關閉 Pixel Crew；進行中的 NPC 工作會中斷")}
            >
              <Icon name="power" />{t("關閉背景服務")}
            </button>}
          </div>
          <div className="top-bar__menu-group">
            <label className="top-bar__menu-toggle" title={t("CTX 快滿時自動把工作交接給全新工作階段（170k 門檻）；關閉後交給 CLI 自行壓縮")}>
              <input
                type="checkbox"
                checked={appToggles?.brainSwapEnabled ?? true}
                disabled={!appToggles}
                onChange={() => toggleAppSetting("brainSwapEnabled")}
              />
              <span><Icon name="brain" />{t("自動換腦")}</span>
            </label>
            <label className="top-bar__menu-toggle" title={t("回合撞到訂閱用量上限時，重置時間一到自動叫 NPC 繼續被中斷的工作")}>
              <input
                type="checkbox"
                checked={appToggles?.limitResumeEnabled ?? true}
                disabled={!appToggles}
                onChange={() => toggleAppSetting("limitResumeEnabled")}
              />
              <span><Icon name="clock" />{t("撞限自動續跑")}</span>
            </label>
            <label className="top-bar__menu-toggle" title={t("僅在這台電腦記錄任務成功率、效能與連線統計；不含 prompt 或路徑，且不會上傳")}>
              <input type="checkbox" checked={appToggles?.diagnosticsEnabled ?? true} disabled={!appToggles} onChange={() => toggleAppSetting("diagnosticsEnabled")} />
              <span><Icon name="chart" />{t("本機診斷")}</span>
            </label>
          </div>
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
            {t("有新版 v{version}", { version: updateInfo.latestVersion ?? "" })}
          </button>
          {updateOpen && (
            <div className="update-popover">
              <strong>{t("Pixel Crew v{version} 已發布", { version: updateInfo.latestVersion ?? "" })}</strong>
              <small>{t("目前版本 v{version}", { version: updateInfo.currentVersion })}</small>
              <a href={updateInfo.releaseUrl ?? "https://github.com/juinwei7/Pixel-Crew/releases/latest"} target="_blank" rel="noreferrer">
                {t("查看 Release（打包版下載新 zip）")}
              </a>
              {updateInfo.oneClickAvailable && onApplyUpdate && <button
                type="button"
                className="update-popover__apply"
                disabled={updateApplying}
                onClick={() => onApplyUpdate()}
              >
                {updateApplying ? t("正在下載並更新…") : t("下載並更新至 v{version}", { version: updateInfo.latestVersion ?? "" })}
              </button>}
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
