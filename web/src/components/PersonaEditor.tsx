import { useEffect, useState } from "react";
import type { Persona, PersonaTemplate, WorkerState } from "../types";
import { apiRequest } from "../api";
import { t } from "../i18n";
import { Modal } from "./Modal";

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
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [memory, setMemory] = useState<string[] | null>(null);
  const [newNote, setNewNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ templates: PersonaTemplate[] }>("/api/persona-templates")
      .then((data) => { if (!cancelled) setTemplates(data.templates ?? []); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    apiRequest<{ notes: string[] }>(`/api/workers/${encodeURIComponent(worker.id)}/extras`)
      .then((data) => { if (!cancelled) setMemory(data.notes ?? []); })
      .catch(() => { if (!cancelled) setMemory([]); });
    return () => { cancelled = true; };
  }, [worker.id]);

  async function addNote() {
    const note = newNote.trim();
    if (!note) return;
    try {
      const data = await apiRequest<{ notes: string[] }>(`/api/workers/${encodeURIComponent(worker.id)}/memory`, {
        method: "POST",
        body: { note },
      });
      setMemory(data.notes ?? []);
      setNewNote("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteNote(index: number) {
    try {
      const data = await apiRequest<{ notes: string[] }>(`/api/workers/${encodeURIComponent(worker.id)}/memory/${index}`, {
        method: "DELETE",
      });
      setMemory(data.notes ?? []);
    } catch (err) {
      setError((err as Error).message);
    }
  }

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
        body: { name: trimmedRole || t("未命名範本"), role: trimmedRole, instructions: trimmedInstructions },
      });
      setTemplates(data.templates ?? []);
      setSavedNotice(t("已存為範本"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTemplateSaving(false);
    }
  }

  async function generateWithAi() {
    if (aiGenerating || saving) return;
    setAiGenerating(true);
    setAiNotice(null);
    setError(null);
    try {
      const data = await apiRequest<{ persona: Persona }>(`/api/workers/${encodeURIComponent(worker.id)}/persona/suggest`, {
        method: "POST",
        timeoutMs: 70_000,
      });
      setRole(data.persona.role);
      setInstructions(data.persona.instructions);
      setSavedNotice(null);
      setAiNotice(t("AI 草稿已填入，確認或修改後再儲存"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAiGenerating(false);
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
    <Modal label={t("{name} 的個性與職務", { name: worker.name })} overlayClassName="persona-editor" cardClassName="persona-editor__card" closeClassName="persona-editor__close" closeLabel={t("關閉個性設定")} onClose={onClose}>
        <header className="persona-editor__header">
          <span className="persona-editor__eyebrow">NPC PERSONA</span>
          <h2>{t("{name} 的個性與職務", { name: worker.name })}</h2>
          <p>{t("設定後會在每次啟動時自動套用，即使 /clear 或重啟也保留，不用每次重講。")}</p>
        </header>

        <div className="persona-editor__ai">
          <button type="button" disabled={aiGenerating || saving} onClick={() => void generateWithAi()}>
            <span aria-hidden="true">✦</span>
            {aiGenerating ? t("AI 正在規劃部門職務…") : next ? t("AI 重新產生人設") : t("AI 幫我產生人設")}
          </button>
          <small>{aiNotice ?? t("會參考工作位置與同部門既有職務，自動補上不重複的角色與工作方式。")}</small>
        </div>

        <div className="persona-editor__templates">
          <button type="button" className="persona-editor__templates-toggle" onClick={() => setTemplatesOpen((open) => !open)} aria-expanded={templatesOpen}>
            {t("套用範本")}{templates.length > 0 ? t("（{count}）", { count: templates.length }) : ""}
            <i className={templatesOpen ? "persona-editor__caret persona-editor__caret--open" : "persona-editor__caret"}>▾</i>
          </button>
          {templatesOpen && (
            <div className="persona-editor__template-list">
              {templates.length === 0 && <div className="persona-editor__template-empty">{t("尚無範本，填好後可「存為範本」")}</div>}
              {templates.map((template) => (
                <div key={template.id} className="persona-editor__template-item">
                  <button type="button" className="persona-editor__template-apply" onClick={() => applyTemplate(template)} title={t("套用此範本到欄位")}>
                    <strong>{template.name}</strong>
                    {template.role && template.role !== template.name && <small>{template.role}</small>}
                  </button>
                  <button type="button" className="persona-editor__template-delete" onClick={() => void deleteTemplate(template.id)} aria-label={t("刪除範本 {name}", { name: template.name })} title={t("刪除範本")}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="persona-editor__field">
          <span>{t("職務 / 角色")}<small>{trimmedRole.length}/{MAX_ROLE}</small></span>
          <input
            value={role}
            maxLength={MAX_ROLE}
            autoFocus
            placeholder={t("例如：前端 QA 工程師")}
            onChange={(event) => { setRole(event.target.value); setError(null); setSavedNotice(null); setAiNotice(null); }}
          />
        </label>

        <label className="persona-editor__field">
          <span>{t("詳細指示")}<small>{trimmedInstructions.length}/{MAX_INSTRUCTIONS}</small></span>
          <textarea
            value={instructions}
            maxLength={MAX_INSTRUCTIONS}
            rows={7}
            spellCheck={false}
            placeholder={t("描述這個 NPC 的專長、工作方式、語氣等。例如：\n你專門測試 UI，回報 bug 時附重現步驟，一律用繁體中文，講話簡潔。")}
            onChange={(event) => { setInstructions(event.target.value); setError(null); setSavedNotice(null); setAiNotice(null); }}
          />
        </label>

        <div className="persona-editor__memory">
          <span className="persona-editor__memory-title">
            {t("🧠 長期記憶")}
            <small>{t("NPC 得知你的偏好時會自己記；改動在下次啟動生效")}</small>
          </span>
          {memory === null ? (
            <div className="persona-editor__template-empty">{t("讀取中…")}</div>
          ) : memory.length === 0 ? (
            <div className="persona-editor__template-empty">{t("還沒有記憶。跟 NPC 聊到你的偏好時它會自己記下來，也可以在下面手動新增。")}</div>
          ) : (
            <ul className="persona-editor__memory-list">
              {memory.map((note, index) => (
                <li key={`${index}-${note}`}>
                  <span>{note}</span>
                  <button type="button" onClick={() => void deleteNote(index)} aria-label={t("刪除記憶：{note}", { note })} title={t("刪除這則記憶")}>×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="persona-editor__memory-add">
            <input
              value={newNote}
              maxLength={200}
              placeholder={t("例：回覆一律繁體中文、講重點不囉嗦")}
              onChange={(event) => setNewNote(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addNote(); } }}
            />
            <button type="button" onClick={() => void addNote()} disabled={!newNote.trim()}>{t("＋記住")}</button>
          </div>
        </div>

        {error && <div className="persona-editor__error" role="alert">{error}</div>}

        <footer className="persona-editor__footer">
          {worker.persona && (
            <button type="button" className="persona-editor__clear" disabled={saving || aiGenerating} onClick={() => void commit(null)}>
              {t("清除人設")}
            </button>
          )}
          <button type="button" className="persona-editor__template-save" disabled={saving || aiGenerating || templateSaving || !next || !!savedNotice} onClick={() => void saveAsTemplate()}>
            {templateSaving ? t("儲存中…") : savedNotice ?? t("存為範本")}
          </button>
          <span className="persona-editor__spacer" />
          <button type="button" className="persona-editor__cancel" disabled={saving} onClick={onClose}>{t("取消")}</button>
          <button type="button" className="persona-editor__save" disabled={saving || aiGenerating || !dirty} onClick={() => void commit(next)}>
            {saving ? t("儲存中…") : t("儲存")}
          </button>
        </footer>
    </Modal>
  );
}
