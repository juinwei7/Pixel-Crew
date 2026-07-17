import { useEffect, useRef, useState } from "react";
import type { AutoApproveMode, CapabilityState, ProviderAuthState, ProviderId, WorkerState } from "../types";
import { roomName } from "../workspace";
import { McpPanel } from "./McpPanel";

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
  onProvider(provider: ProviderId): void;
  onModel(model: string): void;
  onAutoApprove(mode: AutoApproveMode): void;
  onRefreshAuth(): void;
  onResetUi(): void;
  notificationsEnabled: boolean;
  onNotificationsToggle(): void;
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
  onProvider,
  onModel,
  onAutoApprove,
  onRefreshAuth,
  onResetUi,
  notificationsEnabled,
  onNotificationsToggle,
}: Props) {
  const [mcpOpen, setMcpOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const mcpRef = useRef<HTMLDivElement>(null);
  const healthRef = useRef<HTMLDivElement>(null);
  const provider = active?.provider ?? "claude";
  const authReady = auth.status === "authenticated";
  const connected = capabilities.mcpServers.filter((server) =>
    server.status === "connected" || server.status === "enabled"
  ).length;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMcpOpen(false);
        setHealthOpen(false);
      }
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!mcpRef.current?.contains(target)) setMcpOpen(false);
      if (!healthRef.current?.contains(target)) setHealthOpen(false);
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
          value={provider}
          disabled={Boolean(active?.busy) || providerChanging}
          onChange={(event) => onProvider(event.target.value as ProviderId)}
          aria-label="選擇 Agent provider"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select
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
          title="安全：只有唯讀與驗證安全的指令跳過詢問。完全：除了 rm -rf、sudo 等高風險指令，其他都直接放行"
        >
          <option value="off">自動核准：關閉</option>
          <option value="safe">安全自動核准</option>
          <option value="full">完全自動核准</option>
        </select>
      </div>

      <div ref={mcpRef} className="mcp-chip-wrap top-bar__mcp">
        <button
          type="button"
          className={`top-bar__capability ${capabilities.error ? "top-bar__capability--warn" : ""}`}
          onClick={() => { setHealthOpen(false); setMcpOpen((open) => !open); }}
          aria-expanded={mcpOpen}
          title="MCP 能力與連線狀態"
        >
          MCP <strong>{capabilities.loading && capabilities.mcpServers.length === 0 ? "…" : `${connected}/${capabilities.mcpServers.length}`}</strong>
        </button>
        {mcpOpen && <McpPanel capabilities={capabilities} provider={provider} workspacePath={activeWorkspace} />}
      </div>

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
          onClick={() => { setMcpOpen(false); setHealthOpen((open) => !open); }}
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
          </div>
        )}
      </div>
    </header>
  );
}
