import { useEffect, useMemo, useState } from "react";
import { roomName } from "../workspace";
import type { ProviderId } from "../types";
import { CodexSkillCenter } from "./CodexSkillCenter";

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const SERVER_URL = viteEnv?.VITE_SERVER_URL ?? "http://localhost:8787";
const NEW_COMMAND = `---
description: 說明這個指令適合在什麼情況使用
---

請依照以下步驟完成任務：

1. 先理解目前狀況。
2. 說明執行計畫。
3. 完成後驗證結果。
`;

type CommandDocument = {
  name: string;
  description: string;
  argumentHint: string;
  allowedTools: string;
  model: string;
  content: string;
  updatedAt: string;
};

function metadataValue(content: string, key: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return "";
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "im");
  const value = normalized.slice(4, end).match(pattern)?.[1]?.trim() ?? "";
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

export function CommandCenter({
  workspacePath,
  provider,
  onClose,
}: {
  workspacePath: string;
  provider: ProviderId;
  onClose(): void;
}) {
  const [providerView, setProviderView] = useState<ProviderId>(provider);
  const [codexDirty, setCodexDirty] = useState(false);
  const [commands, setCommands] = useState<CommandDocument[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = commands.find((command) => command.name === selectedName) ?? null;
  const dirty = selected
    ? name !== selected.name || content !== selected.content
    : Boolean(name.trim() || content.trim());

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.name} ${command.description}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    if (providerView !== "claude") {
      setLoading(false);
      setCommands([]);
      setSelectedName(null);
      setName("");
      setContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    setCommands([]);
    setSelectedName(null);
    setName("");
    setContent("");
    fetch(`${SERVER_URL}/api/commands?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "無法讀取指令");
        if (!cancelled) setCommands(data.commands ?? []);
      })
      .catch((error) => !cancelled && setNotice({ ok: false, text: error.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [workspacePath, providerView]);

  function switchProviderView(next: ProviderId) {
    if (next === providerView) return;
    const activeDirty = providerView === "claude" ? dirty : codexDirty;
    if (activeDirty && !window.confirm("目前修改尚未儲存，確定要切換 Provider 嗎？")) return;
    setProviderView(next);
    setNotice(null);
  }

  function select(command: CommandDocument) {
    if (dirty && !window.confirm("目前修改尚未儲存，確定要切換指令嗎？")) return;
    setSelectedName(command.name);
    setName(command.name);
    setContent(command.content);
    setNotice(null);
  }

  function create() {
    if (dirty && !window.confirm("目前修改尚未儲存，確定要建立新指令嗎？")) return;
    setSelectedName(null);
    setName("");
    setContent(NEW_COMMAND);
    setNotice(null);
  }

  function close() {
    const activeDirty = providerView === "claude" ? dirty : codexDirty;
    if (activeDirty && !window.confirm("目前修改尚未儲存，確定要關閉嗎？")) return;
    onClose();
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    const response = await fetch(`${SERVER_URL}/api/commands`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspacePath,
        name: name.trim(),
        content,
        originalName: selected?.name,
      }),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      setNotice({ ok: false, text: data.error ?? "儲存失敗" });
      return;
    }
    const saved = data.command as CommandDocument;
    setCommands((current) => [...current.filter((command) => command.name !== selected?.name), saved]
      .sort((a, b) => a.name.localeCompare(b.name)));
    setSelectedName(saved.name);
    setName(saved.name);
    setContent(saved.content);
    setNotice({ ok: true, text: `/${saved.name} 已儲存，斜線選單已更新` });
  }

  async function remove() {
    if (!selected || !window.confirm(`確定要刪除 /${selected.name} 嗎？`)) return;
    setSaving(true);
    setNotice(null);
    const response = await fetch(`${SERVER_URL}/api/commands`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath, name: selected.name }),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      setNotice({ ok: false, text: data.error ?? "刪除失敗" });
      return;
    }
    setCommands((current) => current.filter((command) => command.name !== selected.name));
    setSelectedName(null);
    setName("");
    setContent("");
    setNotice({ ok: true, text: `/${selected.name} 已刪除` });
  }

  const liveDescription = metadataValue(content, "description");
  const liveArgumentHint = metadataValue(content, "argument-hint");

  return (
    <div className="command-center" role="dialog" aria-modal="true" aria-label="指令中心">
      <div className="command-center__shell">
        <header className="command-center__header">
          <div>
            <span className="command-center__eyebrow">PROVIDER WORKFLOWS</span>
            <h2>{providerView === "claude" ? "Claude 指令中心" : "Codex Skills"}</h2>
            <p>{providerView === "claude" ? "管理這個房間的 Claude Code 專屬指令。" : "管理這個房間的 repo-scoped Codex Skills。"}</p>
          </div>
          <div className="command-center__providers" aria-label="Provider">
            <button
              type="button"
              className={providerView === "claude" ? "command-center__provider--active" : ""}
              onClick={() => switchProviderView("claude")}
            >
              CLAUDE CODE
            </button>
            <button
              type="button"
              className={providerView === "codex" ? "command-center__provider--active" : ""}
              onClick={() => switchProviderView("codex")}
            >
              CODEX
            </button>
          </div>
          <div className="command-center__room">
            <span>目前房間</span>
            <strong>{roomName(workspacePath)}</strong>
          </div>
          <button className="command-center__close" type="button" onClick={close} aria-label="關閉">×</button>
        </header>

        {providerView === "claude" ? <div className="command-center__body">
          <aside className="command-library">
            <div className="command-library__actions">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜尋名稱或用途…"
                aria-label="搜尋指令"
              />
              <button type="button" onClick={create}>＋ 新增</button>
            </div>
            <div className="command-library__scope">
              <span>PROJECT</span>
              <code>.claude/commands</code>
            </div>
            <div className="command-library__list">
              {loading && <div className="command-library__empty">正在讀取本機指令…</div>}
              {!loading && filtered.length === 0 && (
                <div className="command-library__empty">這個房間還沒有符合的指令。</div>
              )}
              {filtered.map((command) => (
                <button
                  type="button"
                  key={command.name}
                  className={`command-library__item ${selectedName === command.name ? "command-library__item--active" : ""}`}
                  onClick={() => select(command)}
                >
                  <code>/{command.name}</code>
                  <span>{command.description || "尚未填寫用途說明"}</span>
                </button>
              ))}
            </div>
          </aside>

          <main className="command-editor">
            {!selected && !content ? (
              <div className="command-editor__welcome">
                {notice && <div className="command-editor__load-error" role="alert">{notice.text}</div>}
                <div className="command-editor__glyph">/</div>
                <h3>選擇一個指令開始編輯</h3>
                <p>或建立新的工作流程，儲存後就能直接從輸入框的 `/` 選單使用。</p>
                <button type="button" onClick={create}>建立第一個指令</button>
              </div>
            ) : (
              <>
                <div className="command-editor__top">
                  <label>
                    <span>COMMAND NAME</span>
                    <div className="command-editor__name">
                      <b>/</b>
                      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="finish-work" />
                    </div>
                  </label>
                  <div className="command-editor__meta">
                    <span>{liveDescription || "加入 description，讓其他人知道什麼時候該使用"}</span>
                    {liveArgumentHint && <code>{liveArgumentHint}</code>}
                  </div>
                </div>
                <div className="command-editor__document">
                  <div className="command-editor__bar">
                    <span>MARKDOWN</span>
                    <small>Frontmatter ＋ Prompt</small>
                  </div>
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    spellCheck={false}
                    aria-label="指令 Markdown"
                  />
                </div>
                <footer className="command-editor__footer">
                  <div className={`command-editor__notice ${notice?.ok ? "command-editor__notice--ok" : ""}`}>
                    {notice?.text ?? (dirty ? "有尚未儲存的修改" : "所有修改已儲存")}
                  </div>
                  {selected && <button className="command-editor__delete" type="button" disabled={saving} onClick={() => void remove()}>刪除</button>}
                  <button className="command-editor__save" type="button" disabled={saving || !name.trim() || !content.trim() || !dirty} onClick={() => void save()}>
                    {saving ? "儲存中…" : "儲存指令"}
                  </button>
                </footer>
              </>
            )}
          </main>
        </div> : <CodexSkillCenter workspacePath={workspacePath} onDirtyChange={setCodexDirty} />}
      </div>
    </div>
  );
}
