import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../api";
import { compatibleWorkflowTargets, workflowInvocation, type WorkflowTarget } from "../workflowTypes";
import { parseWorkflowDocument, updateWorkflowDocument, workflowText } from "../workflowDocument";
import { WorkflowDocumentEditor } from "./WorkflowDocumentEditor";

const NEW_SKILL = `---
name: new-skill
description: 說明 Codex 應該在什麼情況使用這個 Skill
---

請依照以下流程完成任務：

1. 理解需求與目前狀況。
2. 執行必要的修改。
3. 驗證結果並清楚回報。
`;

type SkillDocument = {
  name: string;
  description: string;
  content: string;
  updatedAt: string;
};

function replaceSkillName(content: string, name: string): string {
  try {
    return updateWorkflowDocument(content, { name });
  } catch {
    return content;
  }
}

export function CodexSkillCenter({
  workspacePath,
  revision,
  workers,
  activeWorkerId,
  onRun,
  onDirtyChange,
}: {
  workspacePath: string;
  revision: number;
  workers: WorkflowTarget[];
  activeWorkerId: string | null;
  onRun(workerId: string, message: string): Promise<string | null>;
  onDirtyChange(dirty: boolean): void;
}) {
  const [skills, setSkills] = useState<SkillDocument[]>([]);
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
  const selected = skills.find((skill) => skill.name === selectedName) ?? null;
  const dirty = selected
    ? name !== selected.name || content !== selected.content
    : Boolean(name.trim() || content.trim());

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (dirty && !forceReload.current) {
      setExternalChange(true);
      setNotice({ ok: false, text: "Skill 已在外部更新；目前修改尚未被覆蓋" });
      return;
    }
    forceReload.current = false;
    let cancelled = false;
    const scopeChanged = loadScope.current !== workspacePath;
    loadScope.current = workspacePath;
    setLoading(true);
    setNotice(null);
    if (scopeChanged) {
      setSkills([]);
      setSelectedName(null);
      setName("");
      setContent("");
    }
    apiRequest<{ skills: SkillDocument[] }>(`/api/skills?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then((data) => {
        if (cancelled) return;
        const next = data.skills ?? [];
        setSkills(next);
        if (!scopeChanged && selectedName) {
          const refreshed = next.find((skill) => skill.name === selectedName);
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
  }, [workspacePath, revision, reloadNonce]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
      : skills;
  }, [skills, query]);

  function select(skill: SkillDocument) {
    if (dirty && !window.confirm("目前 Skill 修改尚未儲存，確定要切換嗎？")) return;
    setSelectedName(skill.name);
    setName(skill.name);
    setContent(skill.content);
    setNotice(null);
  }

  function create() {
    if (dirty && !window.confirm("目前 Skill 修改尚未儲存，確定要建立新的嗎？")) return;
    setSelectedName(null);
    setName("new-skill");
    setContent(NEW_SKILL);
    setNotice(null);
  }

  function updateName(next: string) {
    setName(next);
    setContent((current) => replaceSkillName(current, next));
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const data = await apiRequest<{ skill: SkillDocument }>("/api/skills", {
        method: "PUT",
        body: { workspacePath, name: name.trim(), content, originalName: selected?.name },
      });
      const saved = data.skill;
      setSkills((current) => [...current.filter((skill) => skill.name !== selected?.name), saved]
        .sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedName(saved.name);
      setName(saved.name);
      setContent(saved.content);
      setExternalChange(false);
      setNotice({ ok: true, text: `$${saved.name} 已儲存，Codex 下次工作即可使用` });
    } catch (error) {
      setExternalChange(true);
      setNotice({ ok: false, text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(`確定刪除 ${selected.name} Skill 及其 references/scripts 資產嗎？`)) return;
    setSaving(true);
    try {
      await apiRequest<{ ok: boolean }>("/api/skills", {
        method: "DELETE",
        body: { workspacePath, name: selected.name },
      });
      setSkills((current) => current.filter((skill) => skill.name !== selected.name));
      setSelectedName(null);
      setName("");
      setContent("");
      setNotice({ ok: true, text: `${selected.name} Skill 已刪除` });
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
      const error = await onRun(effectiveRunTarget, workflowInvocation("codex", selected.name, runInput));
      setNotice(error
        ? { ok: false, text: error }
        : { ok: true, text: `已交給 ${targets.find((target) => target.id === effectiveRunTarget)?.name ?? "NPC"} 試跑` });
    } finally {
      setRunning(false);
    }
  }

  const parsed = useMemo(() => parseWorkflowDocument(content), [content]);
  const description = workflowText(parsed.attributes.description);
  const declaredName = workflowText(parsed.attributes.name);
  const targets = compatibleWorkflowTargets(workers, "codex", workspacePath);
  const effectiveRunTarget = targets.some((target) => target.id === runTargetId)
    ? runTargetId
    : targets.find((target) => target.id === activeWorkerId)?.id ?? targets[0]?.id ?? "";

  return (
    <div className="command-center__body">
      <aside className="command-library command-library--codex">
        <div className="command-library__actions">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋 Skill…" aria-label="搜尋 Skill" />
          <button type="button" onClick={create}>＋ 新增</button>
        </div>
        <div className="command-library__scope">
          <span>CODEX REPO</span>
          <code>.agents/skills</code>
        </div>
        <div className="command-library__list">
          {loading && <div className="command-library__empty">正在讀取 Repo Skills…</div>}
          {!loading && filtered.length === 0 && <div className="command-library__empty">這個房間還沒有 Codex Skill。</div>}
          {filtered.map((skill) => (
            <button
              type="button"
              key={skill.name}
              className={`command-library__item ${selectedName === skill.name ? "command-library__item--active" : ""}`}
              onClick={() => select(skill)}
            >
              <code>${skill.name}</code>
              <span>{skill.description || "尚未填寫觸發情境"}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="command-editor command-editor--codex">
        {!selected && !content ? (
          <div className="command-editor__welcome">
            {notice && <div className="command-editor__load-error" role="alert">{notice.text}</div>}
            <div className="command-editor__glyph command-editor__glyph--codex">$</div>
            <h3>建立可重複使用的 Codex Skill</h3>
            <p>Skill 可以被明確呼叫，也能由 Codex 根據 description 自動選用。</p>
            <button type="button" onClick={create}>建立第一個 Skill</button>
          </div>
        ) : (
          <>
            <div className="command-editor__top">
              <label>
                <span>SKILL NAME</span>
                <div className="command-editor__name">
                  <b>$</b>
                  <input value={name} onChange={(event) => updateName(event.target.value)} placeholder="review-code" />
                </div>
              </label>
              <div className="command-editor__meta">
                <span>{description || "description 決定 Codex 何時會選用這個 Skill"}</span>
                {declaredName && declaredName !== name.trim() && <code>name 不一致</code>}
              </div>
            </div>
            <WorkflowDocumentEditor key={selectedName ?? "new-skill"} provider="codex" content={content} onChange={setContent} />
            {selected && (
              <div className="workflow-test workflow-test--codex">
                <span>試跑</span>
                <select value={effectiveRunTarget} onChange={(event) => setRunTargetId(event.target.value)} disabled={targets.length === 0 || running}>
                  {targets.length === 0 && <option value="">沒有可用的 Codex NPC</option>}
                  {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </select>
                <input value={runInput} onChange={(event) => setRunInput(event.target.value)} placeholder="選填任務情境" />
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
              {selected && <button className="command-editor__delete" type="button" disabled={saving} onClick={() => void remove()}>刪除 Skill</button>}
              <button className="command-editor__save command-editor__save--codex" type="button" disabled={saving || !name.trim() || !content.trim() || !dirty} onClick={() => void save()}>
                {saving ? "儲存中…" : "儲存 Skill"}
              </button>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
