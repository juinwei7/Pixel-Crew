import { useEffect, useRef, useState } from "react";
import type { AutoApproveMode, CapabilityState, ProviderAuthState, ProviderId, UpdateInfo, WorkerState } from "../types";
import { APP_VERSION } from "../appVersion";
import { roomName } from "../workspace";

type ModelOption = { id: string; label: string; description?: string };

type Props = {
  active?: WorkerState;
  activeWorkspace: string;
  capabilities: CapabilityState;
  auth: ProviderAuthState;
  wsReady: boolean;
  modelOptions: ModelOption[];
  workerCount: number;
  providerChanging?: boolean;
  onRoom(): void;
  onOpenMcp(): void;
  onOpenBackup(): void;
  onProvider(provider: ProviderId): void;
  onModel(model: string): void;
  onAutoApprove(mode: AutoApproveMode): void;
  onRefreshAuth(): void;
  onResetUi(): void;
  notificationsEnabled: boolean;
  onNotificationsToggle(): void;
  updateInfo?: UpdateInfo | null;
};

export function TopBar({
  active,
  activeWorkspace,
  capabilities,
  auth,
  wsReady,
  modelOptions,
  workerCount,
  providerChanging = false,
  onRoom,
  onOpenMcp,
  onOpenBackup,
  onProvider,
  onModel,
  onAutoApprove,
  onRefreshAuth,
  onResetUi,
  notificationsEnabled,
  onNotificationsToggle,
  updateInfo = null,
}: Props) {
  const [healthOpen, setHealthOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const updateRef = useRef<HTMLDivElement>(null);
  const healthRef = useRef<HTMLDivElement>(null);
  const provider = active?.provider ?? "claude";
  const authReady = auth.status === "authenticated";
  const connected = capabilities.mcpServers.filter((server) =>
    server.status === "connected" || server.status === "enabled"
  ).length;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHealthOpen(false);
        setUpdateOpen(false);
      }
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!healthRef.current?.contains(target)) setHealthOpen(false);
      if (!updateRef.current?.contains(target)) setUpdateOpen(false);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", closeOutside);
    };
  }, []);

  return (
    <header className="top-bar">
      <div className="top-bar__brand"><i />PIXEL CREW</div>
      <button className="top-bar__room" type="button" onClick={onRoom} title={activeWorkspace}>
        <span>ROOM</span>
        <strong>{roomName(activeWorkspace)}</strong>
        <b>⌄</b>
      </button>

      <div className="top-bar__spacer" />

      <div className="top-bar__agent" aria-label="Agent 設定">
        <span className="top-bar__group-label">AGENT</span>
        <select
          className="top-bar__provider-select"
          value={provider}
          disabled={Boolean(active?.busy) || providerChanging}
          onChange={(event) => onProvider(event.target.value as ProviderId)}
          aria-label="選擇 Agent provider"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select
          className="top-bar__model-select"
          value={active?.model ?? ""}
          disabled={!active || active.busy || !authReady || modelOptions.length === 0}
          onChange={(event) => onModel(event.target.value)}
          aria-label="選擇模型"
        >
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        {capabilities.loading && <span className="top-bar__agent-loading" role="status" aria-label="正在背景更新模型" title="正在背景更新模型"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 7.4 5" /></svg></span>}
        <select
          className={`top-bar__auto-approve top-bar__auto-approve--${active?.autoApproveMode ?? "off"}`}
          value={active?.autoApproveMode ?? "off"}
          disabled={!active}
          onChange={(event) => onAutoApprove(event.target.value as AutoApproveMode)}
          aria-label="自動核准模式"
          title="安全：只有唯讀與驗證安全的指令跳過詢問。完全：除了 rm -rf、sudo 等高風險 shell 指令，其他 shell 指令與所有已連接 MCP server 的工具都會直接放行，不再詢問"
        >
          <option value="off">自動核准：關閉</option>
          <option value="safe">安全自動核准</option>
          <option value="full">完全自動核准</option>
        </select>
      </div>

      <div className="top-bar__mcp">
        <button
          type="button"
          className={`top-bar__capability ${capabilities.error ? "top-bar__capability--warn" : ""}`}
          onClick={() => { setHealthOpen(false); onOpenMcp(); }}
          title="MCP 能力與連線狀態"
        >
          MCP <strong>{capabilities.loading && capabilities.mcpServers.length === 0 ? "…" : `${connected}/${capabilities.mcpServers.length}`}</strong>
        </button>
      </div>

      <details className="top-bar__more">
        <summary aria-label="更多 Agent 設定">•••</summary>
        <div className="top-bar__more-menu">
          <label>
            <span>自動核准</span>
            <select
              value={active?.autoApproveMode ?? "off"}
              disabled={!active}
              onChange={(event) => onAutoApprove(event.target.value as AutoApproveMode)}
              aria-label="更多選單中的自動核准模式"
            >
              <option value="off">關閉</option>
              <option value="safe">安全</option>
              <option value="full">完全</option>
            </select>
          </label>
          <button type="button" onClick={onOpenMcp}>MCP 能力 <strong>{connected}/{capabilities.mcpServers.length}</strong></button>
          {updateInfo?.updateAvailable && <a href={updateInfo.releaseUrl ?? "https://github.com/juinwei7/Pixel-Crew/releases/latest"} target="_blank" rel="noreferrer">更新至 v{updateInfo.latestVersion}</a>}
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
            ⬆ 有新版 v{updateInfo.latestVersion}
          </button>
          {updateOpen && (
            <div className="update-popover">
              <strong>Pixel Crew v{updateInfo.latestVersion} 已發布</strong>
              <small>目前版本 v{updateInfo.currentVersion}</small>
              <a href={updateInfo.releaseUrl ?? "https://github.com/juinwei7/Pixel-Crew/releases/latest"} target="_blank" rel="noreferrer">
                查看 Release（打包版下載新 zip）
              </a>
              <small>git clone 使用者更新方式：</small>
              <code>git pull && npm install && npm run build</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText("git pull && npm install && npm run build"); }}
              >
                複製更新指令
              </button>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className={`top-bar__bell ${notificationsEnabled ? "top-bar__bell--on" : ""}`}
        aria-pressed={notificationsEnabled}
        aria-label="桌面通知"
        title={notificationsEnabled ? "桌面通知：開啟（任務完成、等待核准時通知）" : "桌面通知：關閉"}
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
          aria-label="查看系統健康狀態"
        >
          <i className={`health-dot health-dot--${authReady ? "ok" : auth.status === "checking" ? "checking" : "warn"}`} />
          <i className={`health-dot health-dot--${wsReady ? "ok" : "error"}`} />
          {!authReady && auth.status !== "checking" && <span>需要處理</span>}
        </button>
        {healthOpen && (
          <div className="health-popover">
            <div><i className={`health-dot health-dot--${authReady ? "ok" : "warn"}`} /><span>{auth.displayName}</span><strong>{authReady ? "已就緒" : auth.status === "checking" ? "檢查中" : "需要登入"}</strong></div>
            <div><i className={`health-dot health-dot--${wsReady ? "ok" : "error"}`} /><span>Local server</span><strong>{wsReady ? "已連線" : "重新連線中"}</strong></div>
            {!authReady && <button type="button" onClick={onRefreshAuth}>重新檢查</button>}
            <button type="button" className="health-popover__secondary" onClick={() => { onResetUi(); setHealthOpen(false); }}>重設介面配置</button>
            <button type="button" className="health-popover__secondary" onClick={() => { onOpenBackup(); setHealthOpen(false); }}>備份與還原</button>
            <small className="health-popover__version">
              Pixel Crew v{updateInfo?.currentVersion ?? APP_VERSION}
              {updateInfo?.updateAvailable ? `（最新 v${updateInfo.latestVersion}）` : ""}
            </small>
          </div>
        )}
      </div>
    </header>
  );
}
