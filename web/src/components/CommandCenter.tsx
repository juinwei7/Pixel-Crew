import { useEffect, useMemo, useRef, useState } from "react";
import { roomName } from "../workspace";
import type { ProviderId } from "../types";
import { compatibleWorkflowTargets, workflowInvocation, type WorkflowRevisions, type WorkflowTarget } from "../workflowTypes";
import { apiRequest } from "../api";
import { parseWorkflowDocument, workflowText } from "../workflowDocument";
import { CodexSkillCenter } from "./CodexSkillCenter";
import { WorkflowDocumentEditor } from "./WorkflowDocumentEditor";
import { Modal } from "./Modal";
import { type ConfirmTone } from "./ConfirmDialog";
import { t } from "../i18n";

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
  confirm,
}: {
  workspacePath: string;
  provider: ProviderId;
  workers: WorkflowTarget[];
  activeWorkerId: string | null;
  revisions: WorkflowRevisions;
  onRun(workerId: string, message: string): Promise<string | null>;
  onClose(): void;
  confirm(message: string, tone?: ConfirmTone): Promise<boolean>;
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
      setNotice({ ok: false, text: t("指令檔已在外部更新；目前修改尚未被覆蓋") });
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

  async function switchProviderView(next: ProviderId) {
    if (next === providerView) return;
    const activeDirty = providerView === "claude" ? dirty : codexDirty;
    if (activeDirty && !(await confirm(t("目前修改尚未儲存，確定要切換 Provider 嗎？")))) return;
    setProviderView(next);
    setNotice(null);
  }

  async function select(command: CommandDocument) {
    if (dirty && !(await confirm(t("目前修改尚未儲存，確定要切換指令嗎？")))) return;
    setSelectedName(command.name);
    setName(command.name);
    setContent(command.content);
    setNotice(null);
  }

  async function create() {
    if (dirty && !(await confirm(t("目前修改尚未儲存，確定要建立新指令嗎？")))) return;
    setSelectedName(null);
    setName("");
    setContent(NEW_COMMAND);
    setNotice(null);
  }

  async function close() {
    const activeDirty = providerView === "claude" ? dirty : codexDirty;
    if (activeDirty && !(await confirm(t("目前修改尚未儲存，確定要關閉嗎？")))) return;
    onClose();
  }

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
      setNotice({ ok: true, text: t("/{name} 已儲存，斜線選單已更新", { name: saved.name }) });
    } catch (error) {
      setExternalChange(true);
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected || !(await confirm(t("確定要刪除 /{name} 嗎？", { name: selected.name }), "danger"))) return;
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
      setNotice({ ok: true, text: t("/{name} 已刪除", { name: selected.name }) });
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
        : { ok: true, text: t("已交給 {name} 試跑", { name: targets.find((target) => target.id === effectiveRunTarget)?.name ?? "NPC" }) });
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
    <Modal label={t("指令中心")} overlayClassName="command-center" cardClassName="command-center__shell" hideClose onClose={close}>
        <header className="command-center__header">
          <div>
            <span className="command-center__eyebrow">PROVIDER WORKFLOWS</span>
            <h2>{providerView === "claude" ? t("Claude 指令中心") : "Codex Skills"}</h2>
            <p>{providerView === "claude" ? t("管理這個房間的 Claude Code 專屬指令。") : t("管理這個房間的 repo-scoped Codex Skills。")}</p>
          </div>
          <div className="command-center__providers" aria-label="Provider">
            <button
              type="button"
              className={providerView === "claude" ? "command-center__provider--active" : ""}
              onClick={() => void switchProviderView("claude")}
            >
              CLAUDE CODE
            </button>
            <button
              type="button"
              className={providerView === "codex" ? "command-center__provider--active" : ""}
              onClick={() => void switchProviderView("codex")}
            >
              CODEX
            </button>
          </div>
          <div className="command-center__room">
            <span>{t("目前房間")}</span>
            <strong>{roomName(workspacePath)}</strong>
          </div>
          <button className="command-center__close" type="button" onClick={() => void close()} aria-label={t("關閉")}>×</button>
        </header>

        {providerView === "claude" ? <div className="command-center__body">
          <aside className="command-library">
            <div className="command-library__actions">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("搜尋名稱或用途…")}
                aria-label={t("搜尋指令")}
              />
              <button type="button" onClick={() => void create()}>{t("＋ 新增")}</button>
            </div>
            <div className="command-library__scope">
              <span>PROJECT</span>
              <code>.claude/commands</code>
            </div>
            <div className="command-library__list">
              {loading && <div className="command-library__empty">{t("正在讀取本機指令…")}</div>}
              {!loading && filtered.length === 0 && (
                <div className="command-library__empty">{t("這個房間還沒有符合的指令。")}</div>
              )}
              {filtered.map((command) => (
                <button
                  type="button"
                  key={command.name}
                  className={`command-library__item ${selectedName === command.name ? "command-library__item--active" : ""}`}
                  onClick={() => void select(command)}
                >
                  <code>/{command.name}</code>
                  <span>{command.description || t("尚未填寫用途說明")}</span>
                </button>
              ))}
            </div>
          </aside>

          <main className="command-editor">
            {!selected && !content ? (
              <div className="command-editor__welcome">
                {notice && <div className="command-editor__load-error" role="alert">{notice.text}</div>}
                <div className="command-editor__glyph">/</div>
                <h3>{t("選擇一個指令開始編輯")}</h3>
                <p>{t("或建立新的工作流程，儲存後就能直接從輸入框的 `/` 選單使用。")}</p>
                <button type="button" onClick={() => void create()}>{t("建立第一個指令")}</button>
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
                    <span>{liveDescription || t("加入 description，讓其他人知道什麼時候該使用")}</span>
                    {liveArgumentHint && <code>{liveArgumentHint}</code>}
                  </div>
                </div>
                <WorkflowDocumentEditor key={selectedName ?? "new-command"} provider="claude" content={content} onChange={setContent} />
                {selected && (
                  <div className="workflow-test">
                    <span>{t("試跑")}</span>
                    <select value={effectiveRunTarget} onChange={(event) => setRunTargetId(event.target.value)} disabled={targets.length === 0 || running}>
                      {targets.length === 0 && <option value="">{t("沒有可用的 Claude NPC")}</option>}
                      {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                    </select>
                    <input value={runInput} onChange={(event) => setRunInput(event.target.value)} placeholder={liveArgumentHint || t("選填參數")} />
                    <button type="button" disabled={dirty || !effectiveRunTarget || running} onClick={() => void runWorkflow()}>{running ? t("送出中…") : t("執行")}</button>
                  </div>
                )}
                <footer className="command-editor__footer">
                  <div className={`command-editor__notice ${notice?.ok ? "command-editor__notice--ok" : ""}`}>
                    {notice?.text ?? (dirty ? t("有尚未儲存的修改") : t("所有修改已儲存"))}
                  </div>
                  {externalChange && <button className="command-editor__reload" type="button" onClick={async () => {
                    if (!(await confirm(t("載入外部版本會捨棄目前未儲存的修改，確定嗎？")))) return;
                    forceReload.current = true;
                    setExternalChange(false);
                    setReloadNonce((value) => value + 1);
                  }}>{t("載入外部版本")}</button>}
                  {selected && <button className="command-editor__delete" type="button" disabled={saving} onClick={() => void remove()}>{t("刪除")}</button>}
                  <button className="command-editor__save" type="button" disabled={saving || !name.trim() || !content.trim() || !dirty} onClick={() => void save()}>
                    {saving ? t("儲存中…") : t("儲存指令")}
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
          confirm={confirm}
        />}
    </Modal>
  );
}
