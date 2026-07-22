import { useEffect, useMemo, useRef, useState } from "react";
import type { Department, DepartmentMission, WorkerState } from "../types";
import type { CrewFilter } from "../uiPreferences";
import { SHIRT_COLORS } from "../game/person";
import { roomName } from "../workspace";
import { filterCrew, workerAttention, type WorkerAttention } from "../crew";
import { computeDropIndex, moveId, reorderShift } from "../crewReorder";

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  departments?: Department[];
  missions?: DepartmentMission[];
  selectedDepartmentId?: string | null;
  currentRoom: string;
  filter: CrewFilter;
  collapsed: boolean;
  onFilter(filter: CrewFilter): void;
  onCollapsed(collapsed: boolean): void;
  onSelect(id: string): void;
  onSelectDepartment?(id: string): void;
  onReorder(order: string[]): void;
  onCreate(): void;
  onCreateDepartment?(): void;
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

// Distinguishes an intentional drag from a click (mouse/pen) or a scroll (touch).
const DRAG_THRESHOLD_PX = 6;
const TOUCH_DRAG_DELAY_MS = 350;

export function WorkerTabs({ workers, activeId, departments = [], missions = [], selectedDepartmentId = null, currentRoom, filter, collapsed, onFilter, onCollapsed, onSelect, onSelectDepartment, onReorder, onCreate, onCreateDepartment, onClose, onRename, onAvatar, onPersona, onRoom }: Props) {
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
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; overIndex: number; rowH: number } | null>(null);
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<{ id: string; overIndex: number; rowH: number } | null>(null);
  const matched = useMemo(() => filterCrew(workers, filter, query, currentRoom), [workers, filter, query, currentRoom]);
  const active = workers.find((worker) => worker.id === activeId);
  const pinned = active && !matched.some((worker) => worker.id === active.id) ? active : null;
  // With a filter or search active the visible list is not the full order, so
  // an insertion position would be ambiguous — reordering is disabled there.
  // (In that case `matched === workers` and `pinned` is always null.)
  const canReorder = filter === "all" && query.trim() === "";
  const departmentById = useMemo(() => new Map(departments.map((department) => [department.id, department])), [departments]);
  const groups = useMemo(() => {
    const grouped = new Map<string, WorkerState[]>();
    for (const worker of matched) {
      const key = worker.departmentId ?? `workspace:${worker.workspacePath}`;
      const members = grouped.get(key) ?? [];
      members.push(worker);
      grouped.set(key, members);
    }
    return [...grouped.entries()];
  }, [matched]);
  // Rows render grouped by department, not in flat `workers` order — drag math
  // (computeDropIndex/reorderShift) needs indices in that same rendered order.
  const renderOrder = useMemo(() => groups.flatMap(([, members]) => members), [groups]);

  useEffect(() => {
    const closeMenus = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dragCleanupRef.current?.();
      setMenuId(null);
      setConfirmRemoveId(null);
      setFiltersOpen(false);
      if (editingId === null) setSearchOpen(false);
    };
    window.addEventListener("keydown", closeMenus);
    return () => window.removeEventListener("keydown", closeMenus);
  }, [editingId]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  function updateDrag(next: { id: string; overIndex: number; rowH: number } | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function beginRowDrag(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    dragCleanupRef.current?.();
    const rowEl = (event.currentTarget as HTMLElement).closest<HTMLElement>(".crew-row");
    if (!rowEl) return;
    const pointerId = event.pointerId;
    const pointerType = event.pointerType;
    const startY = event.clientY;
    const rowRect = rowEl.getBoundingClientRect();
    const grabOffset = startY - rowRect.top;
    // Rows shift with CSS transforms while dragging, so live rects would lie.
    // Midpoints are measured once at drag start and corrected for scrolling.
    let baseMids: number[] = [];
    let startScroll = 0;
    let rowH = 0;
    let ghost: HTMLElement | null = null;
    let timer: number | null = null;
    const rowElements = () =>
      Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-worker-id]") ?? []);
    const midYs = () => {
      const scrolled = (listRef.current?.scrollTop ?? startScroll) - startScroll;
      return baseMids.map((mid) => mid - scrolled);
    };
    const setOver = (y: number) => {
      const overIndex = computeDropIndex(midYs(), y);
      if (dragRef.current?.id !== id || dragRef.current.overIndex !== overIndex) {
        updateDrag({ id, overIndex, rowH });
      }
    };
    const moveGhost = (y: number) => {
      if (ghost) ghost.style.top = `${y - grabOffset}px`;
    };
    const startDrag = (y: number) => {
      suppressClickRef.current = true;
      if (pointerType === "touch") navigator.vibrate?.(10);
      baseMids = rowElements().map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      startScroll = listRef.current?.scrollTop ?? 0;
      rowH = rowRect.height + 4; // + the row's margin-bottom
      ghost = rowEl.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-worker-id");
      ghost.classList.remove("crew-row--dragging");
      ghost.classList.add("crew-row--ghost");
      ghost.style.top = `${rowRect.top}px`;
      ghost.style.left = `${rowRect.left}px`;
      ghost.style.width = `${rowRect.width}px`;
      ghost.style.height = `${rowRect.height}px`;
      document.body.appendChild(ghost);
      moveGhost(y);
      setOver(y);
    };
    const blockScroll = (touchEvent: TouchEvent) => {
      if (dragRef.current) touchEvent.preventDefault();
    };
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      ghost?.remove();
      ghost = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", blockScroll);
      dragCleanupRef.current = null;
      if (dragRef.current) {
        updateDrag(null);
        // The click event fires right after pointerup; lift the suppression
        // afterwards so the next ordinary click still selects.
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!dragRef.current) {
        if (Math.abs(moveEvent.clientY - startY) <= DRAG_THRESHOLD_PX) return;
        if (pointerType === "touch") {
          // Moved before the long-press fired: treat it as a scroll.
          cleanup();
          return;
        }
        startDrag(moveEvent.clientY);
      }
      const list = listRef.current;
      if (list) {
        const rect = list.getBoundingClientRect();
        if (moveEvent.clientY < rect.top + 24) list.scrollBy(0, -8);
        else if (moveEvent.clientY > rect.bottom - 24) list.scrollBy(0, 8);
      }
      moveGhost(moveEvent.clientY);
      setOver(moveEvent.clientY);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const current = dragRef.current;
      const ids = rowElements().map((el) => el.dataset.workerId ?? "");
      cleanup();
      if (!current) return;
      const next = moveId(ids, current.id, current.overIndex);
      if (next !== ids) onReorder(next);
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
    };
    if (pointerType === "touch") {
      timer = window.setTimeout(() => {
        timer = null;
        startDrag(startY);
      }, TOUCH_DRAG_DELAY_MS);
    }
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", blockScroll, { passive: false });
  }

  function moveRowByKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, id: string) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const ids = workers.map((worker) => worker.id);
    const from = ids.indexOf(id);
    const next = moveId(ids, id, event.key === "ArrowUp" ? from - 1 : from + 2);
    if (next !== ids) onReorder(next);
  }

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

  const dragFrom = drag ? renderOrder.findIndex((worker) => worker.id === drag.id) : -1;

  function row(worker: WorkerState, isPinned = false, index = -1) {
    const status = workerAttention(worker);
    const menuOpen = menuId === worker.id;
    const editing = editingId === worker.id;
    const draggable = canReorder && !isPinned && !editing;
    const dragging = drag?.id === worker.id;
    const shift = drag && !isPinned && index >= 0 ? reorderShift(index, dragFrom, drag.overIndex, drag.rowH) : 0;
    const selectContents = <>
      <span className="crew-row__avatar" style={{ background: shirtColor(worker.colorIndex) }}>{worker.avatarKind === "custom" ? "◆" : ""}</span>
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
    const npcSelected = selectedDepartmentId === null && worker.id === activeId;
    return (
      <div key={`${isPinned ? "pinned-" : ""}${worker.id}`} data-worker-id={draggable ? worker.id : undefined} style={shift !== 0 ? { transform: `translateY(${shift}px)` } : undefined} className={`crew-row crew-row--${status} ${npcSelected ? "crew-row--active" : ""}${draggable ? " crew-row--draggable" : ""}${dragging ? " crew-row--dragging" : ""}`} title={`${worker.name} · ${roomName(worker.workspacePath)} · ${statusCopy(status)}`}>
        {editing ? <div className="crew-row__select crew-row__select--editing">{selectContents}</div> : <button type="button" className="crew-row__select" aria-current={npcSelected ? "true" : undefined} aria-keyshortcuts={draggable ? "Alt+ArrowUp Alt+ArrowDown" : undefined} onPointerDown={draggable ? (event) => beginRowDrag(event, worker.id) : undefined} onKeyDown={draggable ? (event) => moveRowByKeyboard(event, worker.id) : undefined} onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } onSelect(worker.id); setMenuId(null); }}>{selectContents}</button>}
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
        {!collapsed && onCreateDepartment && <button type="button" className="crew-rail__department-add" onClick={onCreateDepartment} disabled={workers.length > MAX_WORKERS - 2} aria-label="建立部門" title="AI 建立部門"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="2.5" /><circle cx="16" cy="8" r="2.5" /><path d="M3.5 18c.4-3 1.9-4.7 4.5-4.7s4.1 1.7 4.5 4.7M11.5 18c.4-3 1.9-4.7 4.5-4.7s4.1 1.7 4.5 4.7" /></svg></button>}
        <button type="button" className="crew-rail__add" onClick={onCreate} disabled={workers.length >= MAX_WORKERS} aria-label="新增人員" title="新增人員"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
      </div>
      {!collapsed && searchOpen && <input className="crew-rail__search" value={query} autoFocus placeholder="搜尋名字或房間" aria-label="搜尋人員" onChange={(event) => setQuery(event.target.value)} />}
      {!collapsed && filtersOpen && <div className="crew-filters">{FILTERS.map((option) => <button key={option.id} type="button" className={filter === option.id ? "crew-filters__active" : ""} onClick={() => onFilter(option.id)}>{option.label}</button>)}</div>}
      <div ref={listRef} className={`crew-rail__list${drag ? " crew-rail__list--reordering" : ""}`}>
        {pinned && <div className="crew-rail__pinned"><span>目前選取</span>{row(pinned, true)}</div>}
        {groups.map(([key, members]) => {
          const department = departmentById.get(key);
          const mission = missions.find((candidate) => ["planning", "executing", "reviewing", "needs_attention"].includes(candidate.status)
            && (department ? candidate.departmentId === department.id : candidate.workspacePath === members[0]?.workspacePath));
          const completed = mission?.steps.filter((step) => step.status === "completed").length ?? 0;
          const total = mission?.steps.length ?? 0;
          const attention = mission?.status === "needs_attention" || members.some((worker) => workerAttention(worker) === "approval" || workerAttention(worker) === "error");
          const selectable = Boolean(department && onSelectDepartment);
          return <section key={key} className={`crew-department ${department?.id === selectedDepartmentId ? "crew-department--active" : ""} ${attention ? "crew-department--attention" : ""}`} title={department?.purpose || roomName(members[0]?.workspacePath ?? "")}>
            {!collapsed && <button type="button" className="crew-department__header" disabled={!selectable} aria-current={department?.id === selectedDepartmentId ? "true" : undefined} onClick={() => department && onSelectDepartment?.(department.id)}>
              <span><strong>{department?.name ?? roomName(members[0]?.workspacePath ?? "")}</strong><small>{department?.memberWorkerIds.length ?? members.length} 位 NPC</small></span>
              {mission ? <em className={`crew-department__mission crew-department__mission--${mission.status}`}>{mission.status === "needs_attention" ? "需處理" : total ? `${completed}/${total}` : "規劃中"}</em> : <em>待命</em>}
            </button>}
            <div className="crew-department__members">{members.map((worker) => row(worker, false, renderOrder.findIndex((candidate) => candidate.id === worker.id)))}</div>
          </section>;
        })}
        {matched.length === 0 && !pinned && !collapsed && <div className="crew-rail__empty">沒有符合的人員</div>}
      </div>
    </aside>
  );
}
