import { useEffect, useMemo, useState } from "react";

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const SERVER_URL = viteEnv?.VITE_SERVER_URL ?? "http://localhost:8787";
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

function frontmatterValue(content: string, key: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return "";
  const value = normalized.slice(4, end).match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function replaceSkillName(content: string, name: string): string {
  if (/^name:\s*.*$/im.test(content)) return content.replace(/^name:\s*.*$/im, `name: ${name}`);
  if (content.startsWith("---\n")) return content.replace("---\n", `---\nname: ${name}\n`);
  return `---\nname: ${name}\ndescription: \n---\n\n${content}`;
}

export function CodexSkillCenter({
  workspacePath,
  onDirtyChange,
}: {
  workspacePath: string;
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
  const selected = skills.find((skill) => skill.name === selectedName) ?? null;
  const dirty = selected
    ? name !== selected.name || content !== selected.content
    : Boolean(name.trim() || content.trim());

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    fetch(`${SERVER_URL}/api/skills?workspacePath=${encodeURIComponent(workspacePath)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "無法讀取 Codex Skills");
        if (!cancelled) setSkills(data.skills ?? []);
      })
      .catch((error) => !cancelled && setNotice({ ok: false, text: error.message }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [workspacePath]);

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
    const response = await fetch(`${SERVER_URL}/api/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath, name: name.trim(), content, originalName: selected?.name }),
    });
    const data = await response.json().catch(() => ({}));
    setSaving(false);
    if (!response.ok) {
      setNotice({ ok: false, text: data.error ?? "儲存失敗" });
      return;
    }
    const saved = data.skill as SkillDocument;
    setSkills((current) => [...current.filter((skill) => skill.name !== selected?.name), saved]
      .sort((a, b) => a.name.localeCompare(b.name)));
    setSelectedName(saved.name);
    setName(saved.name);
    setContent(saved.content);
    setNotice({ ok: true, text: `$${saved.name} 已儲存，Codex 下次工作即可使用` });
  }

  async function remove() {
    if (!selected || !window.confirm(`確定刪除 ${selected.name} Skill 及其 references/scripts 資產嗎？`)) return;
    setSaving(true);
    const response = await fetch(`${SERVER_URL}/api/skills`, {
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
    setSkills((current) => current.filter((skill) => skill.name !== selected.name));
    setSelectedName(null);
    setName("");
    setContent("");
    setNotice({ ok: true, text: `${selected.name} Skill 已刪除` });
  }

  const description = frontmatterValue(content, "description");
  const declaredName = frontmatterValue(content, "name");

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
            <div className="command-editor__document">
              <div className="command-editor__bar">
                <span>SKILL.md</span>
                <small>Frontmatter ＋ Instructions</small>
              </div>
              <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} aria-label="Skill Markdown" />
            </div>
            <footer className="command-editor__footer">
              <div className={`command-editor__notice ${notice?.ok ? "command-editor__notice--ok" : ""}`}>
                {notice?.text ?? (dirty ? "有尚未儲存的修改" : "所有修改已儲存")}
              </div>
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
