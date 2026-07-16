import { useEffect, useState } from "react";
import type { Persona, PersonaTemplate, WorkerState } from "../types";
import { apiRequest } from "../api";

const MAX_ROLE = 80;
const MAX_INSTRUCTIONS = 4000;

type Props = {
  worker: WorkerState;
  onSave(workerId: string, persona: Persona | null): Promise<string | null>;
  onClose(): void;
};

export function PersonaEditor({ worker, onSave, onClose }: Props) {
  const [role, setRole] = useState(worker.persona?.role ?? "");
  const [instructions, setInstructions] = useState(worker.persona?.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ templates: PersonaTemplate[] }>("/api/persona-templates")
      .then((data) => { if (!cancelled) setTemplates(data.templates ?? []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, []);

  const trimmedRole = role.trim();
  const trimmedInstructions = instructions.trim();
  const next: Persona | null = trimmedRole || trimmedInstructions
    ? { role: trimmedRole, instructions: trimmedInstructions }
    : null;
  const dirty = (worker.persona?.role ?? "") !== trimmedRole
    || (worker.persona?.instructions ?? "") !== trimmedInstructions;

  async function commit(persona: Persona | null) {
    if (saving) return;
    setSaving(true);
    setError(null);
    const message = await onSave(worker.id, persona);
    setSaving(false);
    if (message) { setError(message); return; }
    onClose();
  }

  function applyTemplate(template: PersonaTemplate) {
    setRole(template.role);
    setInstructions(template.instructions);
    setError(null);
    setSavedNotice(null);
    setTemplatesOpen(false);
  }

  async function saveAsTemplate() {
    if (!next || templateSaving || savedNotice) return;
    setTemplateSaving(true);
    setSavedNotice(null);
    setError(null);
    try {
      const data = await apiRequest<{ templates: PersonaTemplate[] }>("/api/persona-templates", {
        method: "POST",
        body: { name: trimmedRole || "未命名範本", role: trimmedRole, instructions: trimmedInstructions },
      });
      setTemplates(data.templates ?? []);
      setSavedNotice("已存為範本");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTemplateSaving(false);
    }
  }

  async function deleteTemplate(id: string) {
    try {
      const data = await apiRequest<{ templates: PersonaTemplate[] }>(`/api/persona-templates/${encodeURIComponent(id)}`, { method: "DELETE" });
      setTemplates(data.templates ?? []);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="persona-editor" role="dialog" aria-modal="true" aria-labelledby="persona-editor-title">
      <div className="persona-editor__card">
        <button type="button" className="persona-editor__close" onClick={onClose} aria-label="關閉個性設定">×</button>
        <header className="persona-editor__header">
          <span className="persona-editor__eyebrow">NPC PERSONA</span>
          <h2 id="persona-editor-title">{worker.name} 的個性與職務</h2>
          <p>設定後會在每次啟動時自動套用，即使 /clear 或重啟也保留，不用每次重講。</p>
        </header>

        <div className="persona-editor__templates">
          <button type="button" className="persona-editor__templates-toggle" onClick={() => setTemplatesOpen((open) => !open)} aria-expanded={templatesOpen}>
            套用範本{templates.length > 0 ? `（${templates.length}）` : ""}
            <i className={templatesOpen ? "persona-editor__caret persona-editor__caret--open" : "persona-editor__caret"}>▾</i>
          </button>
          {templatesOpen && (
            <div className="persona-editor__template-list">
              {templates.length === 0 && <div className="persona-editor__template-empty">尚無範本，填好後可「存為範本」</div>}
              {templates.map((template) => (
                <div key={template.id} className="persona-editor__template-item">
                  <button type="button" className="persona-editor__template-apply" onClick={() => applyTemplate(template)} title="套用此範本到欄位">
                    <strong>{template.name}</strong>
                    {template.role && template.role !== template.name && <small>{template.role}</small>}
                  </button>
                  <button type="button" className="persona-editor__template-delete" onClick={() => void deleteTemplate(template.id)} aria-label={`刪除範本 ${template.name}`} title="刪除範本">×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="persona-editor__field">
          <span>職務 / 角色<small>{trimmedRole.length}/{MAX_ROLE}</small></span>
          <input
            value={role}
            maxLength={MAX_ROLE}
            autoFocus
            placeholder="例如：前端 QA 工程師"
            onChange={(event) => { setRole(event.target.value); setError(null); setSavedNotice(null); }}
          />
        </label>

        <label className="persona-editor__field">
          <span>詳細指示<small>{trimmedInstructions.length}/{MAX_INSTRUCTIONS}</small></span>
          <textarea
            value={instructions}
            maxLength={MAX_INSTRUCTIONS}
            rows={7}
            spellCheck={false}
            placeholder={"描述這個 NPC 的專長、工作方式、語氣等。例如：\n你專門測試 UI，回報 bug 時附重現步驟，一律用繁體中文，講話簡潔。"}
            onChange={(event) => { setInstructions(event.target.value); setError(null); setSavedNotice(null); }}
          />
        </label>

        {error && <div className="persona-editor__error" role="alert">{error}</div>}

        <footer className="persona-editor__footer">
          {worker.persona && (
            <button type="button" className="persona-editor__clear" disabled={saving} onClick={() => void commit(null)}>
              清除人設
            </button>
          )}
          <button type="button" className="persona-editor__template-save" disabled={saving || templateSaving || !next || !!savedNotice} onClick={() => void saveAsTemplate()}>
            {templateSaving ? "儲存中…" : savedNotice ?? "存為範本"}
          </button>
          <span className="persona-editor__spacer" />
          <button type="button" className="persona-editor__cancel" disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className="persona-editor__save" disabled={saving || !dirty} onClick={() => void commit(next)}>
            {saving ? "儲存中…" : "儲存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
