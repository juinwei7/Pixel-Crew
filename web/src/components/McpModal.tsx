import { useEffect, useRef, useState } from "react";
import type { CapabilityState, McpLoginResult, McpScope, McpServerState, ProviderId } from "../types";
import { apiRequest } from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";

function isEditable(name: string): boolean {
  return /^[\w.-]+$/.test(name);
}

const SCOPE_LABEL: Record<McpScope, string> = {
  local: "本機（此專案私有）",
  project: "專案共享（.mcp.json）",
  user: "全域（所有專案）",
  account: "claude.ai 帳號",
};

function statusLabel(status: string): string {
  switch (status) {
    case "connected":
    case "enabled":
      return "已連線";
    case "connected_tools_failed":
      return "已連線·工具清單讀取失敗";
    case "needs_auth":
      return "需授權";
    case "failed":
      return "連線失敗";
    case "pending":
      return "連線中…";
    case "pending_approval":
      return "待核准";
    case "disabled":
      return "已停用";
    default:
      return status || "未知";
  }
}

function detailLine(server: McpServerState): string | null {
  const parts: string[] = [];
  if (server.transport) parts.push(server.transport);
  if (server.transport === "stdio" && server.command) parts.push([server.command, ...(server.args ?? [])].join(" "));
  else if (server.url) parts.push(server.url);
  if (server.envKeys?.length) parts.push(`env: ${server.envKeys.join(", ")}`);
  if (server.headerNames?.length) parts.push(`headers: ${server.headerNames.join(", ")}`);
  if (server.detail) parts.push(server.detail);
  return parts.length ? parts.join(" · ") : null;
}

type EnvRow = { key: string; value: string };
type HeaderRow = { name: string; value: string };
type McpReloadSummary = { reloaded: number; deferred: number; failed: number };

export function reloadNotice(action: string, reload?: McpReloadSummary): { ok: boolean; text: string } {
  if (!reload) return { ok: true, text: action };
  if (reload.failed > 0) {
    return { ok: false, text: `${action}；${reload.failed} 個 NPC 重連失敗` };
  }
  if (reload.deferred > 0) {
    return { ok: true, text: `${action}；${reload.reloaded} 個 NPC 已重連，${reload.deferred} 個執行中的 NPC 會在下一回合前自動重載` };
  }
  return { ok: true, text: `${action}；目前 session 已重連 MCP` };
}

type Props = {
  capabilities: CapabilityState;
  provider: ProviderId;
  workspacePath: string;
  mcpLoginResult: (McpLoginResult & { seq: number }) | null;
  platform?: string;
  // Claude has no API to list a connected MCP server's tools — server name
  // → tool names actually called so far, as the only fallback content.
  usedMcpTools?: Record<string, string[]>;
  notify(message: string, tone?: "ok" | "error" | "info"): void;
  onClose(): void;
};

export function McpModal({ capabilities, provider, workspacePath, mcpLoginResult, platform, usedMcpTools, notify, onClose }: Props) {
  const servers = capabilities.mcpServers;
  const activeServerCount = servers.filter((s) => s.status === "connected" || s.status === "enabled").length;

  // Kept separate so refreshing/removing/logging out one row doesn't
  // relabel the unrelated "加入" submit button as "處理中…".
  const [pending, setPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingLogins, setPendingLogins] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  const [addMode, setAddMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"local" | "project" | "user">("local");
  const [transport, setTransport] = useState<"stdio" | "sse" | "http">("stdio");
  const [target, setTarget] = useState("");
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [json, setJson] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [callbackPort, setCallbackPort] = useState("");
  const [clientId, setClientId] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthResource, setOauthResource] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Codex has neither `add-json` nor SSE transport — clamp the form back to
  // something valid if the user switched provider mid-edit.
  useEffect(() => {
    if (provider !== "codex") return;
    if (transport === "sse") setTransport("http");
    if (addMode === "json") setAddMode("form");
  }, [provider, transport, addMode]);

  useEffect(() => {
    // Codex only — Claude has no CLI-level way to list a server's tools, so
    // there's nothing to fetch. The response arrives via the existing
    // capabilities_updated WS broadcast, not this call's own return value.
    if (provider !== "codex") return;
    void apiRequest("/api/mcp/tools", { method: "POST", body: { provider, workspacePath }, timeoutMs: 20000 }).catch(() => {});
  }, [provider, workspacePath]);

  useEffect(() => {
    if (!mcpLoginResult) return;
    if (mcpLoginResult.provider !== provider || mcpLoginResult.workspacePath !== workspacePath) return;
    setPendingLogins((current) => {
      if (!current[mcpLoginResult.name]) return current;
      const next = { ...current };
      delete next[mcpLoginResult.name];
      return next;
    });
    const label = { succeeded: "登入成功", failed: "登入失敗", timeout: "登入逾時", cancelled: "已取消登入" }[mcpLoginResult.status];
    notify(
      `${mcpLoginResult.name}：${label}${mcpLoginResult.message ? ` — ${mcpLoginResult.message}` : ""}`,
      mcpLoginResult.ok ? "ok" : "error",
    );
    // Only re-run when a new event actually arrives (seq bump), not on every
    // provider/workspacePath render — those are read fresh via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpLoginResult?.seq]);

  async function refresh() {
    setPending(true);
    setNotice(null);
    try {
      const data = await apiRequest<{ reload?: McpReloadSummary }>("/api/mcp/refresh", { method: "POST", body: { provider, workspacePath }, timeoutMs: 65000 });
      setNotice(reloadNotice("MCP 狀態與工具已更新", data.reload));
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setPending(false);
    }
  }

  async function remove(server: McpServerState) {
    setPending(true);
    setNotice(null);
    try {
      const scope = provider === "claude" && server.scope && server.scope !== "account" ? `&scope=${server.scope}` : "";
      const data = await apiRequest<{ reload?: McpReloadSummary }>(`/api/mcp/${encodeURIComponent(server.name)}?provider=${provider}&workspacePath=${encodeURIComponent(workspacePath)}${scope}`, {
        method: "DELETE",
        timeoutMs: 65000,
      });
      setNotice(reloadNotice(`已移除 ${server.name}`, data.reload));
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setPending(false);
    }
  }

  async function login(serverName: string) {
    setPendingLogins((current) => ({ ...current, [serverName]: true }));
    try {
      await apiRequest("/api/mcp/login", { method: "POST", body: { provider, workspacePath, name: serverName } });
    } catch (error) {
      setPendingLogins((current) => {
        const next = { ...current };
        delete next[serverName];
        return next;
      });
      notify((error as Error).message, "error");
    }
  }

  async function cancelLogin(serverName: string) {
    try {
      await apiRequest("/api/mcp/login/cancel", { method: "POST", body: { provider, workspacePath, name: serverName } });
    } finally {
      setPendingLogins((current) => {
        const next = { ...current };
        delete next[serverName];
        return next;
      });
    }
  }

  async function logout(serverName: string) {
    setPending(true);
    setNotice(null);
    try {
      await apiRequest("/api/mcp/logout", { method: "POST", body: { provider, workspacePath, name: serverName }, timeoutMs: 35000 });
      setNotice({ ok: true, text: `已登出 ${serverName}` });
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setPending(false);
    }
  }

  async function resetProjectChoices() {
    setPending(true);
    setNotice(null);
    try {
      const data = await apiRequest<{ message: string }>("/api/mcp/reset-project-choices", { method: "POST", body: { workspacePath } });
      setNotice({ ok: true, text: data.message });
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setPending(false);
    }
  }

  async function importFromClaudeDesktop() {
    setPending(true);
    setNotice(null);
    try {
      const data = await apiRequest<{ message: string }>("/api/mcp/import-from-claude-desktop", { method: "POST", body: { workspacePath, scope }, timeoutMs: 65000 });
      setNotice({ ok: true, text: data.message });
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setPending(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { provider, workspacePath, name: name.trim() };
      if (addMode === "json") {
        body.mode = "json";
        body.json = json.trim();
        if (provider === "claude") body.scope = scope;
      } else {
        body.transport = transport;
        body.target = target.trim();
        if (provider === "claude") body.scope = scope;
        if (transport === "stdio") {
          body.env = envRows.filter((row) => row.key.trim()).map((row) => `${row.key.trim()}=${row.value}`);
        } else {
          body.headers = headerRows.filter((row) => row.name.trim()).map((row) => `${row.name.trim()}: ${row.value}`);
          if (provider === "claude") {
            if (callbackPort.trim()) body.callbackPort = callbackPort.trim();
            if (clientId.trim()) body.clientId = clientId.trim();
          } else {
            if (oauthClientId.trim()) body.oauthClientId = oauthClientId.trim();
            if (oauthResource.trim()) body.oauthResource = oauthResource.trim();
          }
        }
      }
      const data = await apiRequest<{ reload?: McpReloadSummary }>("/api/mcp", { method: "POST", timeoutMs: 65000, body });
      setNotice(reloadNotice(`已加入 ${name.trim()}`, data.reload));
      setName("");
      setTarget("");
      setEnvRows([]);
      setHeaderRows([]);
      setJson("");
      setCallbackPort("");
      setClientId("");
      setOauthClientId("");
      setOauthResource("");
    } catch (error) {
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const hasPendingApproval = servers.some((s) => s.status === "pending_approval");
  const canSubmitAdd = Boolean(name.trim()) && (addMode === "json" ? Boolean(json.trim()) : Boolean(target.trim()));

  return (
    <div ref={dialogRef} className="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-modal-title">
      <div className="mcp-modal__card">
        <button type="button" className="mcp-modal__close" onClick={onClose} aria-label="關閉 MCP 管理">×</button>
        <header className="mcp-modal__header">
          <span className="mcp-modal__eyebrow">MCP SERVERS</span>
          <h2 id="mcp-modal-title">
            {capabilities.loading
              ? "讀取中…"
              : capabilities.toolCount == null
                ? `${activeServerCount}/${servers.length} 個連線中`
                : `${capabilities.toolCount} 個工具 · ${capabilities.source === "cache" ? "快取" : "已更新"}`}
          </h2>
          {provider === "claude" && platform === "darwin" && (
            <button type="button" className="mcp-modal__refresh" disabled={pending} title="從 Claude Desktop 應用程式匯入已設定的 MCP servers" onClick={() => void importFromClaudeDesktop()}>
              從 Claude Desktop 匯入
            </button>
          )}
          <button type="button" className="mcp-modal__refresh" disabled={pending || capabilities.loading} onClick={() => void refresh()}>
            ↻ 重新讀取
          </button>
        </header>

        {hasPendingApproval && provider === "claude" && (
          <div className="mcp-modal__hint">
            有伺服器待核准（僅能在真人互動式終端核准，PixelCrew 無法代為核准）。
            <button type="button" onClick={() => void resetProjectChoices()} disabled={pending}>重設本專案核准記憶</button>
          </div>
        )}
        {capabilities.error && <div className="mcp-modal__warning">更新失敗，目前顯示最後一次資料</div>}

        <section className="mcp-modal__list">
          {capabilities.loading && servers.length === 0 && (
            <div className="mcp-modal__skeleton" aria-label="正在讀取 MCP servers"><i /><i /><i /></div>
          )}
          {!capabilities.loading && servers.length === 0 && <div className="mcp-modal__empty">沒有設定 MCP server</div>}
          {servers.map((server) => {
            const detail = detailLine(server);
            const loggingIn = Boolean(pendingLogins[server.name]);
            const editable = isEditable(server.name) && !server.builtin;
            const connected = server.status === "connected" || server.status === "enabled";
            const toolsFetchFailed = server.status === "connected_tools_failed";
            const authenticated = connected || toolsFetchFailed;
            // Codex's `status` (enabled/disabled) is about whether the server
            // itself is on, not authentication, so it must NOT be reused as
            // "authenticated" the way Claude's `connected` is — `authStatus`
            // is the only real signal, and only meaningful for non-stdio
            // servers ("unsupported" for stdio). The exact enum of
            // "authenticated" isn't fully documented; treating anything other
            // than the literal "authenticated" as "not yet" is the safer
            // default (worst case: an extra, harmless login button; the CLI's
            // own error message is the fallback if it's already logged in).
            const codexAuthApplicable = provider === "codex" && !server.builtin && typeof server.authStatus === "string" && server.authStatus !== "unsupported";
            const codexAuthenticated = codexAuthApplicable && server.authStatus === "authenticated";
            const showLogin = (server.status === "needs_auth" && !server.builtin) || (codexAuthApplicable && !codexAuthenticated);
            const showLogout = (authenticated && server.transport !== "stdio" && provider !== "codex" && !server.builtin) || (codexAuthApplicable && codexAuthenticated);
            const expanded = Boolean(expandedTools[server.name]);
            const usedTools = usedMcpTools?.[server.name] ?? [];
            return (
              <div key={server.name} className="mcp-modal__row">
                <span className={`mcp-modal__dot ${connected ? "mcp-modal__dot--on" : toolsFetchFailed ? "mcp-modal__dot--warn" : ""}`} />
                <div className="mcp-modal__info">
                  <div className="mcp-modal__info-top">
                    <span className="mcp-modal__name">{server.name}</span>
                    {server.scope && <span className={`mcp-modal__badge mcp-modal__badge--${server.scope}`}>{SCOPE_LABEL[server.scope]}</span>}
                    {server.transport && <span className="mcp-modal__badge mcp-modal__badge--transport">{server.transport}</span>}
                    {server.builtin && <span className="mcp-modal__badge mcp-modal__badge--builtin">Codex 內建</span>}
                  </div>
                  <div className="mcp-modal__status-line">
                    <span className="mcp-modal__status">{statusLabel(server.status)}</span>
                    {server.status === "pending_approval" && <span className="mcp-modal__note">僅能在真人互動式終端核准</span>}
                    {toolsFetchFailed && <span className="mcp-modal__note">可嘗試「重新讀取」或查看細節</span>}
                  </div>
                  {detail && <div className="mcp-modal__detail">{detail}</div>}
                  <div className="mcp-modal__tools">
                    <button
                      type="button"
                      className="mcp-modal__tools-toggle"
                      onClick={() => setExpandedTools((current) => ({ ...current, [server.name]: !current[server.name] }))}
                    >
                      {expanded ? "隱藏工具" : "查看工具"}
                      {provider === "codex" && server.tools ? `（${server.tools.length}）` : ""}
                    </button>
                    {provider === "claude" && <span className="mcp-modal__note">僅顯示已使用過的工具</span>}
                    {provider === "codex" && server.toolsStatus !== "available" && (
                      <span className="mcp-modal__note">工具清單目前無法讀取</span>
                    )}
                    {expanded && (
                      <div className="mcp-modal__tools-list">
                        {provider === "codex" && server.toolsStatus === "available" && (
                          server.tools && server.tools.length > 0 ? (
                            server.tools.map((tool) => (
                              <div key={tool.name} className="mcp-modal__tools-name">
                                {tool.name}
                                {tool.description && <span className="mcp-modal__tools-desc"> — {tool.description}</span>}
                              </div>
                            ))
                          ) : (
                            <div className="mcp-modal__tools-empty">此伺服器目前沒有提供任何工具</div>
                          )
                        )}
                        {provider === "codex" && server.toolsStatus !== "available" && (
                          <div className="mcp-modal__tools-fallback">
                            目前無法取得完整工具清單（可能是實驗性 API 已變動，或尚無運作中的 Codex 工人）。
                          </div>
                        )}
                        {provider === "claude" && (
                          usedTools.length > 0 ? (
                            <>
                              <div className="mcp-modal__tools-fallback">此 provider 目前無法列出完整工具清單，僅顯示已使用過的工具。</div>
                              {usedTools.map((toolName) => (
                                <div key={toolName} className="mcp-modal__tools-name">{toolName}</div>
                              ))}
                            </>
                          ) : (
                            <div className="mcp-modal__tools-empty">此 provider 目前無法列出完整工具清單，僅顯示已使用過的工具；尚未使用過這個伺服器的任何工具。</div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mcp-modal__actions">
                  {/* Login/logout are safe, reversible auth-only actions — unlike
                      remove, they're not restricted to editable names, since
                      claude.ai account connectors are exactly what most often
                      needs them. */}
                  {showLogin && (
                    loggingIn ? (
                      <span className="mcp-modal__login-pending">
                        等待瀏覽器授權中…
                        <button type="button" onClick={() => void cancelLogin(server.name)}>取消</button>
                      </span>
                    ) : (
                      <button type="button" className="mcp-modal__login" onClick={() => void login(server.name)}>登入</button>
                    )
                  )}
                  {showLogout && (
                    <button type="button" className="mcp-modal__logout" disabled={pending} onClick={() => void logout(server.name)}>登出</button>
                  )}
                  {editable && (
                    <button type="button" className="mcp-modal__remove" title="移除這個 MCP server" disabled={pending} onClick={() => void remove(server)}>移除</button>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        <form className="mcp-modal__add" onSubmit={add}>
          <div className="mcp-modal__add-title">
            新增 MCP SERVER
            {provider === "claude" && (
              <button type="button" className="mcp-modal__mode-toggle" onClick={() => setAddMode((mode) => (mode === "form" ? "json" : "form"))}>
                {addMode === "form" ? "進階：貼上 JSON" : "改用表單"}
              </button>
            )}
          </div>

          <input className="mcp-modal__input" placeholder="名稱（英數、-、_、.）" value={name} onChange={(e) => setName(e.target.value)} />

          {provider === "claude" && (
            <select className="mcp-modal__input" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="local">本機（此專案私有）</option>
              <option value="project">專案共享（.mcp.json）</option>
              <option value="user">全域（所有專案）</option>
            </select>
          )}

          {addMode === "json" ? (
            <>
              <textarea
                className="mcp-modal__input mcp-modal__json"
                rows={5}
                placeholder='{"type": "stdio", "command": "npx", "args": ["my-mcp-server"]}'
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
              <div className="mcp-modal__hint-inline">需包含 "type"（stdio 或 sse），否則詳細資訊可能不完整。</div>
            </>
          ) : (
            <>
              <div className="mcp-modal__transport">
                {(["stdio", "http", "sse"] as const)
                  .filter((option) => !(provider === "codex" && option === "sse"))
                  .map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={transport === option ? "mcp-modal__transport-active" : ""}
                      onClick={() => setTransport(option)}
                    >
                      {option}
                    </button>
                  ))}
              </div>
              <input
                className="mcp-modal__input"
                placeholder={transport === "stdio" ? "stdio 指令，例如 npx my-mcp-server" : "https://…/mcp"}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />

              {transport === "stdio" ? (
                <div className="mcp-modal__rows">
                  <div className="mcp-modal__rows-title">環境變數（選填）</div>
                  {envRows.map((row, index) => (
                    <div key={index} className="mcp-modal__row-inputs">
                      <input aria-label={`環境變數 ${index + 1} 名稱`} placeholder="KEY" value={row.key} onChange={(e) => setEnvRows((rows) => rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))} />
                      <input aria-label={`環境變數 ${index + 1} 值`} placeholder="value" value={row.value} onChange={(e) => setEnvRows((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
                      <button type="button" aria-label={`移除環境變數 ${index + 1}`} onClick={() => setEnvRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
                    </div>
                  ))}
                  <button type="button" className="mcp-modal__row-add" onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}>+ 新增環境變數</button>
                </div>
              ) : provider === "claude" ? (
                <div className="mcp-modal__rows">
                  <div className="mcp-modal__rows-title">Header（選填）</div>
                  {headerRows.map((row, index) => (
                    <div key={index} className="mcp-modal__row-inputs">
                      <input aria-label={`Header ${index + 1} 名稱`} placeholder="Name" value={row.name} onChange={(e) => setHeaderRows((rows) => rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))} />
                      <input aria-label={`Header ${index + 1} 值`} placeholder="value" value={row.value} onChange={(e) => setHeaderRows((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
                      <button type="button" aria-label={`移除 Header ${index + 1}`} onClick={() => setHeaderRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
                    </div>
                  ))}
                  <button type="button" className="mcp-modal__row-add" onClick={() => setHeaderRows((rows) => [...rows, { name: "", value: "" }])}>+ 新增 Header</button>
                </div>
              ) : (
                <div className="mcp-modal__hint-inline">OAuth 或 bearer token 請先用 codex mcp login／終端設定。</div>
              )}

              {transport !== "stdio" && (
                <div className="mcp-modal__rows">
                  <button type="button" className="mcp-modal__mode-toggle" onClick={() => setAdvancedOpen((open) => !open)}>
                    {advancedOpen ? "隱藏進階選項" : "進階選項（OAuth）"}
                  </button>
                  {advancedOpen && (
                    provider === "claude" ? (
                      <>
                        <input className="mcp-modal__input" placeholder="Callback port（選填，固定 OAuth 回呼埠）" value={callbackPort} onChange={(e) => setCallbackPort(e.target.value)} />
                        <input className="mcp-modal__input" placeholder="Client ID（選填）" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                        <div className="mcp-modal__hint-inline">需要 client secret 的伺服器請改用終端機執行 claude mcp add ... --client-secret（CLI 刻意不讓明碼 secret 經過任何 API）。</div>
                      </>
                    ) : (
                      <>
                        <input className="mcp-modal__input" placeholder="OAuth client ID（選填）" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} />
                        <input className="mcp-modal__input" placeholder="OAuth resource（選填）" value={oauthResource} onChange={(e) => setOauthResource(e.target.value)} />
                      </>
                    )
                  )}
                </div>
              )}
            </>
          )}

          <button className="mcp-modal__submit" type="submit" disabled={submitting || !canSubmitAdd}>
            {submitting ? "處理中…" : "加入"}
          </button>
          {notice && <div className={`mcp-modal__notice ${notice.ok ? "" : "mcp-modal__notice--err"}`}>{notice.text}</div>}
        </form>
      </div>
    </div>
  );
}
