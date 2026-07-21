import { useEffect, useMemo, useRef, useState } from "react";
import { roomName } from "../workspace";
import type { ProviderId } from "../types";
import { compatibleWorkflowTargets, workflowInvocation, type WorkflowRevisions, type WorkflowTarget } from "../workflowTypes";
import { apiRequest } from "../api";
import { parseWorkflowDocument, workflowText } from "../workflowDocument";
import { CodexSkillCenter } from "./CodexSkillCenter";
import { WorkflowDocumentEditor } from "./WorkflowDocumentEditor";
import { useFocusTrap } from "../hooks/useFocusTrap";

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

export function CommandCenter({
  workspacePath,
  provider,
  workers,
  activeWorkerId,
  revisions,
  onRun,
  onClose,
}: {
  workspacePath: string;
  provider: ProviderId;
  workers: WorkflowTarget[];
  activeWorkerId: string | null;
  revisions: WorkflowRevisions;
  onRun(workerId: string, message: string): Promise<string | null>;
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
  const [externalChange, setExternalChange] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const forceReload = useRef(false);
  const loadScope = useRef("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const [runTargetId, setRunTargetId] = useState(activeWorkerId ?? "");
  const [runInput, setRunInput] = useState("");
  const [running, setRunning] = useState(false);
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
    if (dirty && !forceReload.current) {
      setExternalChange(true);
      setNotice({ ok: false, text: "指令檔已在外部更新；目前修改尚未被覆蓋" });
      return;
    }
    forceReload.current = false;
    let cancelled = false;
    const scope = `claude\0${workspacePath}`;
    const scopeChanged = loadScope.current !== scope;
    loadScope.current = scope;
    setLoading(true);
    setNotice(null);
    if (scopeChanged) {
      setCommands([]);
      setSelectedName(null);
      setName("");
      setContent("");
    }
    apiRequest<{ commands: CommandDocument[] }>(`/api/commands?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then((data) => {
        if (cancelled) return;
        const next = data.commands ?? [];
        setCommands(next);
        if (!scopeChanged && selectedName) {
          const refreshed = next.find((command) => command.name === selectedName);
          if (refreshed) {
            setName(refreshed.name);
            setContent(refreshed.content);
          } else {
            setSelectedName(null);
            setName("");
            setContent("");
          }
        }
        setExternalChange(false);
      })
      .catch((error) => !cancelled && setNotice({ ok: false, text: error.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [workspacePath, providerView, revisions.claude, reloadNonce]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [codexDirty, dirty, onClose, providerView]);

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const data = await apiRequest<{ command: CommandDocument }>("/api/commands", {
        method: "PUT",
        body: { workspacePath, name: name.trim(), content, originalName: selected?.name },
      });
      const saved = data.command;
      setCommands((current) => [...current.filter((command) => command.name !== selected?.name), saved]
        .sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedName(saved.name);
      setName(saved.name);
      setContent(saved.content);
      setExternalChange(false);
      setNotice({ ok: true, text: `/${saved.name} 已儲存，斜線選單已更新` });
    } catch (error) {
      setExternalChange(true);
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`確定要刪除 /${selected.name} 嗎？`)) return;
    setSaving(true);
    setNotice(null);
    try {
      await apiRequest<{ ok: boolean }>("/api/commands", {
        method: "DELETE",
        body: { workspacePath, name: selected.name },
      });
      setCommands((current) => current.filter((command) => command.name !== selected.name));
      setSelectedName(null);
      setName("");
      setContent("");
      setNotice({ ok: true, text: `/${selected.name} 已刪除` });
    } catch (error) {
      setExternalChange(true);
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function runWorkflow() {
    if (!selected || dirty || !effectiveRunTarget) return;
    setRunning(true);
    setNotice(null);
    try {
      const error = await onRun(effectiveRunTarget, workflowInvocation("claude", selected.name, runInput));
      setNotice(error
        ? { ok: false, text: error }
        : { ok: true, text: `已交給 ${targets.find((target) => target.id === effectiveRunTarget)?.name ?? "NPC"} 試跑` });
    } finally {
      setRunning(false);
    }
  }

  const parsed = useMemo(() => parseWorkflowDocument(content), [content]);
  const liveDescription = workflowText(parsed.attributes.description);
  const liveArgumentHint = workflowText(parsed.attributes["argument-hint"]);
  const targets = compatibleWorkflowTargets(workers, "claude", workspacePath);
  const effectiveRunTarget = targets.some((target) => target.id === runTargetId)
    ? runTargetId
    : targets.find((target) => target.id === activeWorkerId)?.id ?? targets[0]?.id ?? "";

  return (
    <div ref={dialogRef} className="command-center" role="dialog" aria-modal="true" aria-label="指令中心">
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
                <WorkflowDocumentEditor key={selectedName ?? "new-command"} provider="claude" content={content} onChange={setContent} />
                {selected && (
                  <div className="workflow-test">
                    <span>試跑</span>
                    <select value={effectiveRunTarget} onChange={(event) => setRunTargetId(event.target.value)} disabled={targets.length === 0 || running}>
                      {targets.length === 0 && <option value="">沒有可用的 Claude NPC</option>}
                      {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                    </select>
                    <input value={runInput} onChange={(event) => setRunInput(event.target.value)} placeholder={liveArgumentHint || "選填參數"} />
                    <button type="button" disabled={dirty || !effectiveRunTarget || running} onClick={() => void runWorkflow()}>{running ? "送出中…" : "執行"}</button>
                  </div>
                )}
                <footer className="command-editor__footer">
                  <div className={`command-editor__notice ${notice?.ok ? "command-editor__notice--ok" : ""}`}>
                    {notice?.text ?? (dirty ? "有尚未儲存的修改" : "所有修改已儲存")}
                  </div>
                  {externalChange && <button className="command-editor__reload" type="button" onClick={() => {
                    if (!window.confirm("載入外部版本會捨棄目前未儲存的修改，確定嗎？")) return;
                    forceReload.current = true;
                    setExternalChange(false);
                    setReloadNonce((value) => value + 1);
                  }}>載入外部版本</button>}
                  {selected && <button className="command-editor__delete" type="button" disabled={saving} onClick={() => void remove()}>刪除</button>}
                  <button className="command-editor__save" type="button" disabled={saving || !name.trim() || !content.trim() || !dirty} onClick={() => void save()}>
                    {saving ? "儲存中…" : "儲存指令"}
                  </button>
                </footer>
              </>
            )}
          </main>
        </div> : <CodexSkillCenter
          workspacePath={workspacePath}
          revision={revisions.codex}
          workers={workers}
          activeWorkerId={activeWorkerId}
          onRun={onRun}
          onDirtyChange={setCodexDirty}
        />}
      </div>
    </div>
  );
}
