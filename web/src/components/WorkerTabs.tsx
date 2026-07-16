import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkerState } from "../types";
import type { CrewFilter } from "../uiPreferences";
import { SHIRT_COLORS } from "../game/person";
import { roomName } from "../workspace";
import { filterCrew, workerAttention, type WorkerAttention } from "../crew";

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  currentRoom: string;
  filter: CrewFilter;
  collapsed: boolean;
  onFilter(filter: CrewFilter): void;
  onCollapsed(collapsed: boolean): void;
  onSelect(id: string): void;
  onCreate(): void;
  onClose(id: string): void;
  onRename(id: string, name: string): Promise<string | null>;
  onAvatar(id: string): void;
  onPersona(id: string): void;
  onRoom(id: string): void;
};

const MAX_WORKERS = 20;
// Roughly the tallest the row menu gets (5 actions). Used to decide whether to
// open it downward or flip it up when a row sits near the bottom of the rail.
const MENU_ESTIMATED_HEIGHT = 210;

function shirtColor(index: number): string {
  const [color] = SHIRT_COLORS[index % SHIRT_COLORS.length];
  return `#${color.toString(16).padStart(6, "0")}`;
}

const FILTERS: Array<{ id: CrewFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "working", label: "執行中" },
  { id: "attention", label: "需處理" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "room", label: "此房間" },
];

function statusCopy(status: WorkerAttention): string {
  return { approval: "等待核准", error: "執行失敗", working: "執行中", done: "已完成", idle: "待命" }[status];
}

export function WorkerTabs({ workers, activeId, currentRoom, filter, collapsed, onFilter, onCollapsed, onSelect, onCreate, onClose, onRename, onAvatar, onPersona, onRoom }: Props) {
  const railRef = useRef<HTMLElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuDropUp, setMenuDropUp] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const matched = useMemo(() => filterCrew(workers, filter, query, currentRoom), [workers, filter, query, currentRoom]);
  const active = workers.find((worker) => worker.id === activeId);
  const pinned = active && !matched.some((worker) => worker.id === active.id) ? active : null;

  useEffect(() => {
    const closeMenus = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuId(null);
      setConfirmRemoveId(null);
      setFiltersOpen(false);
      if (editingId === null) setSearchOpen(false);
    };
    window.addEventListener("keydown", closeMenus);
    return () => window.removeEventListener("keydown", closeMenus);
  }, [editingId]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (railRef.current?.contains(event.target as Node)) return;
      setMenuId(null);
      setConfirmRemoveId(null);
      setFiltersOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, []);

  async function saveName(id: string) {
    const error = await onRename(id, draft);
    if (error) {
      setRenameError(error);
      return;
    }
    setEditingId(null);
    setRenameError(null);
    setMenuId(null);
  }

  function row(worker: WorkerState, isPinned = false) {
    const status = workerAttention(worker);
    const menuOpen = menuId === worker.id;
    const editing = editingId === worker.id;
    const selectContents = <>
      <span className="crew-row__avatar" style={{ background: shirtColor(worker.colorIndex) }}>{worker.avatarId ? "◆" : ""}</span>
      {!collapsed && <>
        <div className="crew-row__identity">
          {editing ? (
            <input value={draft} maxLength={24} autoFocus className={renameError ? "crew-row__rename--error" : ""} title={renameError ?? "Enter 儲存，Esc 取消"} onChange={(event) => { setDraft(event.target.value); setRenameError(null); }} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void saveName(worker.id); }
              if (event.key === "Escape") { setEditingId(null); setRenameError(null); }
            }} />
          ) : <strong>{worker.name}</strong>}
          <small>{worker.persona?.role ? <span className="crew-row__role" title={`職務：${worker.persona.role}`}>{worker.persona.role}</span> : null}{isPinned ? "目前選取 · " : ""}{roomName(worker.workspacePath)}</small>
        </div>
        <span className={`crew-row__provider crew-row__provider--${worker.provider}`}>{worker.provider === "claude" ? "CL" : "CX"}</span>
      </>}
      <span className={`crew-row__status crew-row__status--${status}`} aria-label={statusCopy(status)} title={statusCopy(status)}>{status === "approval" ? "!" : status === "error" ? "×" : status === "working" ? "…" : status === "done" ? "✓" : "·"}</span>
    </>;
    return (
      <div key={`${isPinned ? "pinned-" : ""}${worker.id}`} className={`crew-row crew-row--${status} ${worker.id === activeId ? "crew-row--active" : ""}`} title={`${worker.name} · ${roomName(worker.workspacePath)} · ${statusCopy(status)}`}>
        {editing ? <div className="crew-row__select crew-row__select--editing">{selectContents}</div> : <button type="button" className="crew-row__select" aria-current={worker.id === activeId ? "true" : undefined} onClick={() => { onSelect(worker.id); setMenuId(null); }}>{selectContents}</button>}
        {!collapsed && <button type="button" className="crew-row__menu-button" aria-label={`${worker.name} 更多操作`} aria-expanded={menuOpen} onClick={(event) => { event.stopPropagation(); const opening = !menuOpen; if (opening) { const btn = event.currentTarget.getBoundingClientRect(); const railBottom = railRef.current?.getBoundingClientRect().bottom ?? window.innerHeight; setMenuDropUp(railBottom - btn.bottom < MENU_ESTIMATED_HEIGHT); } setMenuId(opening ? worker.id : null); setConfirmRemoveId(null); }}>•••</button>}
        {menuOpen && !collapsed && (
          <div className={`crew-row__menu ${menuDropUp ? "crew-row__menu--up" : ""}`} onClick={(event) => event.stopPropagation()}>
            {confirmRemoveId === worker.id ? <div className="crew-row__confirm"><span>確定移除？</span><button type="button" onClick={() => { onClose(worker.id); setMenuId(null); }}>移除</button><button type="button" onClick={() => setConfirmRemoveId(null)}>取消</button></div> : <>
              <button type="button" onClick={() => { setEditingId(worker.id); setDraft(worker.name); setRenameError(null); }}>重新命名</button>
              <button type="button" onClick={() => { onPersona(worker.id); setMenuId(null); }}>個性 / 職務</button>
              <button type="button" onClick={() => { onAvatar(worker.id); setMenuId(null); }}>像素角色</button>
              <button type="button" onClick={() => { onRoom(worker.id); setMenuId(null); }}>切換房間</button>
              {workers.length > 1 && <button type="button" className="crew-row__danger" onClick={() => worker.busy || worker.turns.length > 0 ? setConfirmRemoveId(worker.id) : (onClose(worker.id), setMenuId(null))}>移除人員</button>}
            </>}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside ref={railRef} className={`crew-rail ${collapsed ? "crew-rail--collapsed" : ""}`}>
      <div className="crew-rail__head">
        {!collapsed && <strong>CREW <span>{workers.length}/{MAX_WORKERS}</span></strong>}
        <button type="button" onClick={() => onCollapsed(!collapsed)} aria-label={collapsed ? "展開人員列" : "收合人員列"} title={collapsed ? "展開人員列" : "收合人員列"}><svg viewBox="0 0 24 24" aria-hidden="true">{collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="M15 6 9 12l6 6" />}</svg></button>
        {!collapsed && <button type="button" className={searchOpen ? "crew-rail__filter-active" : ""} onClick={() => setSearchOpen((open) => !open)} aria-label="搜尋人員" title="搜尋人員"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></svg></button>}
        {!collapsed && <button type="button" onClick={() => setFiltersOpen((open) => !open)} aria-label="篩選人員" title="篩選人員" className={filter !== "all" ? "crew-rail__filter-active" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg></button>}
        <button type="button" className="crew-rail__add" onClick={onCreate} disabled={workers.length >= MAX_WORKERS} aria-label="新增人員" title="新增人員"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
      </div>
      {!collapsed && searchOpen && <input className="crew-rail__search" value={query} autoFocus placeholder="搜尋名字或房間" aria-label="搜尋人員" onChange={(event) => setQuery(event.target.value)} />}
      {!collapsed && filtersOpen && <div className="crew-filters">{FILTERS.map((option) => <button key={option.id} type="button" className={filter === option.id ? "crew-filters__active" : ""} onClick={() => onFilter(option.id)}>{option.label}</button>)}</div>}
      <div className="crew-rail__list">
        {pinned && <div className="crew-rail__pinned"><span>目前選取</span>{row(pinned, true)}</div>}
        {matched.map((worker) => row(worker))}
        {matched.length === 0 && !pinned && !collapsed && <div className="crew-rail__empty">沒有符合的人員</div>}
      </div>
    </aside>
  );
}
