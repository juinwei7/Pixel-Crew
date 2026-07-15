import { useState } from "react";
import type { CapabilityState, ProviderId } from "../types";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787";

function isEditable(name: string): boolean {
  return /^[\w.-]+$/.test(name);
}

export function McpPanel({
  capabilities,
  provider,
}: {
  capabilities: CapabilityState;
  provider: ProviderId;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [header, setHeader] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const servers = capabilities.mcpServers;
  const activeServerCount = servers.filter(
    (server) => server.status === "connected" || server.status === "enabled",
  ).length;
  const isUrl = /^https?:\/\//.test(target.trim());

  async function refresh() {
    setPending(true);
    setNotice(null);
    const res = await fetch(`${SERVER_URL}/api/mcp/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    setPending(false);
    setNotice(res.ok ? { ok: true, text: "MCP 狀態已更新" } : { ok: false, text: "更新失敗" });
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setNotice(null);
    const res = await fetch(`${SERVER_URL}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        name: name.trim(),
        target: target.trim(),
        header: provider === "claude" ? header.trim() : "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    setPending(false);
    if (res.ok) {
      setNotice({ ok: true, text: `已加入 ${name.trim()}，工人下一句話生效` });
      setName("");
      setTarget("");
      setHeader("");
    } else {
      setNotice({ ok: false, text: data.error ?? "加入失敗" });
    }
  }

  async function remove(serverName: string) {
    setPending(true);
    setNotice(null);
    const res = await fetch(`${SERVER_URL}/api/mcp/${encodeURIComponent(serverName)}?provider=${provider}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    setPending(false);
    setNotice(
      res.ok
        ? { ok: true, text: `已移除 ${serverName}，工人下一句話生效` }
        : { ok: false, text: data.error ?? "移除失敗" },
    );
  }

  return (
    <div className="mcp-popover">
      <div className="mcp-popover__title">
        MCP SERVERS
        <span className="mcp-popover__tools">
          {capabilities.loading
            ? "讀取中…"
            : capabilities.toolCount == null
              ? `${activeServerCount}/${servers.length} active`
              : `${capabilities.toolCount} tools · ${capabilities.source === "cache" ? "快取" : "已更新"}`}
          <button
            type="button"
            className="mcp-popover__refresh"
            title="重新讀取 MCP"
            disabled={pending || capabilities.loading}
            onClick={() => void refresh()}
          >
            ↻
          </button>
        </span>
      </div>

      {servers.length === 0 && (
        <div className="mcp-popover__empty">
          {capabilities.loading ? "正在讀取 MCP servers…" : "沒有設定 MCP server"}
        </div>
      )}
      {capabilities.error && (
        <div className="mcp-popover__warning">更新失敗，目前顯示最後一次資料</div>
      )}
      {servers.map((s) => (
        <div key={s.name} className="mcp-popover__row">
          <span
            className={`mcp-popover__dot ${
              s.status === "connected" || s.status === "enabled" ? "mcp-popover__dot--on" : ""
            }`}
          />
          <span className="mcp-popover__name">{s.name}</span>
          <span className="mcp-popover__status">{s.status}</span>
          {isEditable(s.name) && (
            <button
              className="mcp-popover__remove"
              title="移除這個 MCP server"
              disabled={pending}
              onClick={() => remove(s.name)}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <form className="mcp-add" onSubmit={add}>
        <div className="mcp-add__title">新增 MCP SERVER</div>
        <input
          className="mcp-add__input"
          placeholder="名稱（英數、-、_）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="mcp-add__input"
          placeholder="https://…/mcp 或 stdio 指令"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        {isUrl && provider === "claude" && (
          <input
            className="mcp-add__input"
            placeholder="Header（選填，如 Authorization: Bearer <token>）"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
          />
        )}
        {isUrl && provider === "codex" && (
          <div className="mcp-add__hint">OAuth 或 bearer token 請先用 codex mcp login／終端設定。</div>
        )}
        <button
          className="mcp-add__submit"
          type="submit"
          disabled={pending || !name.trim() || !target.trim()}
        >
          {pending ? "處理中…" : "加入"}
        </button>
        {notice && (
          <div className={`mcp-add__notice ${notice.ok ? "" : "mcp-add__notice--err"}`}>
            {notice.text}
          </div>
        )}
      </form>
    </div>
  );
}
