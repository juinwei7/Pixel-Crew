import { Container, Graphics, Text } from "pixi.js";
import { SHIRT_COLORS } from "./crewLook";
import { ART_W, ART_H } from "./room";
import { t } from "../i18n";
import { dayKey, lampLit, noteHit, noteLayout, paperBalls, queueCard, trinketFor, trinketPixels, type QueueCard } from "./deskProps";

export type DepartmentPhase = "reviewing" | "returning" | "planning" | "executing" | "mission_review" | "mission_consult" | "needs_attention" | null;

export type PersonalDeskState = {
  id: string;
  name: string;
  colorIndex: number;
  active: boolean;
  workspacePath: string;
  departmentKey?: string;
  workspaceLabel: string;
  collaborationPhase: DepartmentPhase;
  missionProgress?: { completed: number; total: number } | null;
  /** 老闆交辦臨時部門成員——整個部門會被圈進一間有牆的獨立房間，與常駐夥伴分開。 */
  ephemeral?: boolean;
  /** 部門任務「當前步驟」的負責人——桌位畫值勤指標，一眼看出現在到誰。 */
  onDuty?: boolean;
  /** Scene worker state already carries this; working/thinking keeps the night desk lamp on. */
  character?: { activity: string };
};

/** Tap on a desk's queued-command sticky notes: the first three commands + where to float the card. */
export type QueueNotesTap = {
  id: string;
  items: string[];
  card: QueueCard;
  /** Pointer position in canvas (global) px. */
  global: { x: number; y: number };
};

export type DepartmentSeat = {
  id: string;
  x: number;
  y: number;
  deskBottom: number;
  row: number;
  column: number;
};

export type DepartmentSegment = {
  row: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  deskBottom: number;
  /** The shared table surface only spans the desks, not the whole mat. */
  benchLeft: number;
  benchRight: number;
};

export type DepartmentZone = {
  kind: "department" | "personal";
  /** 老闆交辦臨時部門：畫成一間有牆、有門牌的獨立房間，而不是安靜的地墊。 */
  boss: boolean;
  workspacePath: string;
  workspaceLabel: string;
  memberCount: number;
  phase: DepartmentPhase;
  missionProgress: { completed: number; total: number } | null;
  accent: number;
  segments: DepartmentSegment[];
};

export type DepartmentDeskLayout = {
  seats: Map<string, DepartmentSeat>;
  departments: DepartmentZone[];
  /** Total floor height in art px: ART_H, or more when desk rows spill into the annex. */
  floorHeight: number;
};

type DeskEntry = {
  container: Container;
  highlight: Graphics;
  blueprint: Graphics;
  effect: Graphics;
  /** 值勤箭頭（每幀重繪做上下浮動動畫），與 highlight 分離避免被 setWorkers 的 clear 打斷。 */
  duty: Graphics;
  onDuty: boolean;
  parts: Graphics[];
  transition: "building" | "ready" | "removing";
  transitionMs: number;
  /** Lamp, trinket, sticky notes, waste bin — static, redrawn only when propsKey changes. */
  props: Graphics;
  /** Invisible tap target over the sticky notes (only interactive while the queue is non-empty). */
  notesHit: Container;
  propsKey: string;
  busy: boolean;
  /** performance.now() of the last moment we saw this worker busy; null = not since load. */
  lastBusyAt: number | null;
};

type PhaseHighlight = {
  graphics: Graphics;
  segments: DepartmentSegment[];
  phase: Exclude<DepartmentPhase, null>;
};

/** Max seats a department places on one bench row before wrapping. */
export const DEPARTMENT_SEAT_COLUMNS = 6;
const SEAT_PITCH = 52;
const DEPT_GAP = 10;
const ZONE_PAD = 27;
const ROW_MARGIN = 12;
// Rows need enough air below the seat for the DOM nameplate (a fixed CSS
// size, so it eats more of the art-space gap the smaller the camera is
// zoomed) plus the next row's floating caption above it — 9px of raw gap
// (58 - 49) was invisible at low zoom and let the two collide.
const ROW_PITCH = 64;
/** Zone extent above/below the seat stand point — hugs sign, desk and feet. */
const ZONE_TOP = 38;
const ZONE_BOTTOM = 8;
/** Floor band reserved for departments, below the shared tool stations. */
const BAND_TOP = 104;
const BAND_BOTTOM = 282;
/** Desk rows that fit in the main office's band; any more go to the annex floor below. */
const BASE_ROWS = 3;
/** The annex starts under the main office, past a short divider wall (drawn by Room). */
export const ANNEX_TOP = ART_H + 16;
const ANNEX_FIRST_ROW = ANNEX_TOP + ZONE_TOP + 10;
const BUILD_MS = 980;
const REMOVE_MS = 720;
const DEPARTMENT_ACCENTS = [0x4de3ff, 0x37d6a3, 0x8a73e8, 0xffb15c, 0x5dc8ff];

function steppedProgress(value: number, steps = 8): number {
  return Math.floor(Math.max(0, Math.min(1, value)) * steps) / steps;
}

function workspaceAccent(path: string): number {
  let hash = 0;
  for (let index = 0; index < path.length; index++) hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  return DEPARTMENT_ACCENTS[hash % DEPARTMENT_ACCENTS.length];
}

function zoneWidth(seatCount: number): number {
  return (seatCount - 1) * SEAT_PITCH + ZONE_PAD * 2;
}

/**
 * Shelf-packs departments into centered rows. A department is one block with
 * a walkway gap to its neighbours; it only splits across rows when it holds
 * more than DEPARTMENT_SEAT_COLUMNS members, so small departments never get
 * torn apart mid-row the way the old uniform grid did.
 */
export function departmentDeskLayout(workers: PersonalDeskState[]): DepartmentDeskLayout {
  const seats = new Map<string, DepartmentSeat>();
  const groups = new Map<string, PersonalDeskState[]>();
  for (const worker of workers) {
    const key = worker.departmentKey ?? worker.workspacePath;
    const group = groups.get(key);
    if (group) group.push(worker);
    else groups.set(key, [worker]);
  }

  // 老闆交辦臨時部門（ephemeral）排在最後、而且獨佔自己的列，不跟常駐夥伴同排——
  // 這樣常駐區保持乾淨，臨時部門各自圈成一間看得出邊界的房間。
  const isBossGroup = (members: PersonalDeskState[]) => members.some((member) => member.ephemeral);
  const standingGroups = [...groups.values()].filter((members) => !isBossGroup(members));
  const bossGroups = [...groups.values()].filter(isBossGroup);

  const budget = ART_W - ROW_MARGIN * 2;
  type Chunk = { members: PersonalDeskState[]; left: number };
  const rows: Array<{ width: number; chunks: Chunk[] }> = [];
  const packGroups = (groupList: PersonalDeskState[][], forceOwnRow: boolean) => {
    for (const members of groupList) {
      for (let start = 0; start < members.length; start += DEPARTMENT_SEAT_COLUMNS) {
        const chunkMembers = members.slice(start, start + DEPARTMENT_SEAT_COLUMNS);
        const width = zoneWidth(chunkMembers.length);
        let row = rows[rows.length - 1];
        // forceOwnRow：老闆交辦房間開新列（start===0 的第一段），不與別的部門併排。
        const mustBreak = forceOwnRow && start === 0;
        if (!row || mustBreak || (row.chunks.length > 0 && row.width + DEPT_GAP + width > budget)) {
          row = { width: 0, chunks: [] };
          rows.push(row);
        }
        const left = row.chunks.length > 0 ? row.width + DEPT_GAP : 0;
        row.chunks.push({ members: chunkMembers, left });
        row.width = left + width;
      }
    }
  };
  packGroups(standingGroups, false);
  packGroups(bossGroups, true);

  // Rows sit at the upper third of the department band instead of clinging to
  // its top edge, so a small crew doesn't leave a huge dead floor below.
  // Big crews: the first BASE_ROWS rows fill the main office band, the rest
  // continue in the annex below the meeting room (the floor grows; the main
  // office itself never changes shape, so small crews look exactly as before).
  const baseRows = Math.min(rows.length, BASE_ROWS);
  const extent = baseRows ? (baseRows - 1) * ROW_PITCH + ZONE_TOP + ZONE_BOTTOM : 0;
  const firstRowY = BAND_TOP + ZONE_TOP + Math.max(0, Math.floor((BAND_BOTTOM - BAND_TOP - extent) / 3));
  const rowY = (index: number) => index < BASE_ROWS
    ? firstRowY + index * ROW_PITCH
    : ANNEX_FIRST_ROW + (index - BASE_ROWS) * ROW_PITCH;
  const floorHeight = rows.length > BASE_ROWS ? rowY(rows.length - 1) + ZONE_BOTTOM + 30 : ART_H;

  rows.forEach((row, rowIndex) => {
    const offset = ROW_MARGIN + Math.floor((budget - row.width) / 2);
    const y = rowY(rowIndex);
    let column = 0;
    for (const chunk of row.chunks) {
      chunk.members.forEach((member, seatIndex) => {
        seats.set(member.id, {
          id: member.id,
          x: Math.round(offset + chunk.left + ZONE_PAD + seatIndex * SEAT_PITCH),
          y,
          deskBottom: y - 14,
          row: rowIndex,
          column: column++,
        });
      });
    }
  });

  const departments = [...groups.entries()].map(([departmentKey, members]): DepartmentZone => {
    const byRow = new Map<number, DepartmentSeat[]>();
    for (const member of members) {
      const seat = seats.get(member.id);
      if (!seat) continue;
      const row = byRow.get(seat.row);
      if (row) row.push(seat);
      else byRow.set(seat.row, [seat]);
    }
    const segments = [...byRow.entries()].map(([row, rowSeats]): DepartmentSegment => {
      const ordered = [...rowSeats].sort((a, b) => a.column - b.column);
      return {
        row,
        left: ordered[0].x - ZONE_PAD,
        right: ordered[ordered.length - 1].x + ZONE_PAD,
        top: ordered[0].y - ZONE_TOP,
        bottom: ordered[0].y + ZONE_BOTTOM,
        deskBottom: ordered[0].deskBottom,
        benchLeft: ordered[0].x - 16,
        benchRight: ordered[ordered.length - 1].x + 16,
      };
    });
    const phase = members.find((member) => member.collaborationPhase)?.collaborationPhase ?? null;
    const missionProgress = members.find((member) => member.missionProgress)?.missionProgress ?? null;
    const boss = members.some((member) => member.ephemeral);
    return {
      kind: members.length >= 2 ? "department" : "personal",
      boss,
      workspacePath: departmentKey,
      workspaceLabel: members[0].workspaceLabel,
      memberCount: members.length,
      phase,
      missionProgress,
      accent: workspaceAccent(departmentKey),
      segments,
    };
  });

  return { seats, departments, floorHeight };
}

export class PersonalDeskLayer {
  readonly container = new Container();
  private readonly departmentLayer = new Container();
  private readonly deskLayer = new Container();
  private readonly entries = new Map<string, DeskEntry>();
  private phaseHighlights: PhaseHighlight[] = [];
  private readonly reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  private night = false;
  private day = dayKey(new Date());
  /** Queued commands per worker (full list; the desk shows the count, the card the first three). */
  private readonly queues = new Map<string, string[]>();
  /** Today's failed jobs per worker — paper balls in the desk's waste bin. */
  private readonly failures = new Map<string, number>();
  private lampCheckMs = 0;
  /** Set by the scene: a tap on a desk's sticky notes (the UI floats a card listing the commands). */
  onQueueNotesTap: ((tap: QueueNotesTap) => void) | null = null;

  constructor(
    private readonly onSelect: (id: string) => void,
    private readonly onDepartmentSelect?: (workspacePath: string) => void,
    private readonly onDepartmentRename?: (workspacePath: string, position: { x: number; y: number }) => void,
    private readonly isDragging: () => boolean = () => false,
  ) {
    this.container.sortableChildren = true;
    this.departmentLayer.zIndex = -10;
    this.deskLayer.sortableChildren = true;
    this.container.addChild(this.departmentLayer, this.deskLayer);
  }

  /** Night lamps: the scene calls this from its day/night tick (same flag as room.setNight). */
  setNight(night: boolean): void {
    if (night === this.night) return;
    this.night = night;
    this.refreshAllProps();
  }

  /** Daily counters (waste-bin paper) clear when the local day changes. Call alongside room.setClock. */
  setClock(date: Date): void {
    const day = dayKey(date);
    if (day === this.day) return;
    this.day = day;
    this.failures.clear();
    this.refreshAllProps();
  }

  /** Queued commands for one worker (oldest first). One sticky note per command, max three + a pad. */
  setQueue(id: string, items: readonly string[]): void {
    const prev = this.queues.get(id);
    if (items.length === 0) {
      if (!prev) return;
      this.queues.delete(id);
    } else {
      if (prev && prev.length === items.length && prev.every((item, i) => item === items[i])) return;
      this.queues.set(id, [...items]);
    }
    this.refreshProps(id);
  }

  /** Today's failed-job count for one worker: one paper ball each in the desk's bin (max five). */
  setFailures(id: string, count: number): void {
    const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    if ((this.failures.get(id) ?? 0) === n) return;
    if (n === 0) this.failures.delete(id);
    else this.failures.set(id, n);
    this.refreshProps(id);
  }

  /** One more failed job for this worker (for event-driven callers). */
  addFailure(id: string): void {
    this.setFailures(id, (this.failures.get(id) ?? 0) + 1);
  }

  /** Card content for a worker's queue (what a sticky-note tap shows). */
  queueCardFor(id: string): QueueCard | null {
    const items = this.queues.get(id);
    return items?.length ? queueCard(items) : null;
  }

  setWorkers(workers: PersonalDeskState[]): DepartmentDeskLayout {
    const layout = departmentDeskLayout(workers);
    this.renderDepartments(layout.departments);
    const seen = new Set<string>();
    workers.forEach((worker) => {
      seen.add(worker.id);
      let entry = this.entries.get(worker.id);
      if (!entry) {
        entry = this.createDesk(worker);
        this.entries.set(worker.id, entry);
        this.deskLayer.addChild(entry.container);
      } else if (entry.transition === "removing") {
        entry.transition = "building";
        entry.transitionMs = BUILD_MS * 0.35;
        entry.container.eventMode = "static";
      }
      const spot = layout.seats.get(worker.id);
      if (!spot) return;
      entry.container.position.set(spot.x, spot.deskBottom);
      entry.container.zIndex = spot.deskBottom;
      entry.highlight.clear();
      if (worker.active) {
        entry.highlight.roundRect(-17, -24, 34, 30, 4).stroke({
          width: 1,
          color: SHIRT_COLORS[worker.colorIndex % SHIRT_COLORS.length]?.[0] ?? 0x4de3ff,
          alpha: 0.72,
        });
      }
      // 值勤指標：部門任務「當前步驟」的負責人。金色實框（靜態）＋螢幕上方一枚
      // 上下浮動的向下箭頭（動畫在 update(dt) 每幀重繪），讓「現在到誰了」在一排
      // 同款桌位裡一眼可辨（與淡色的選取框刻意做出強弱差）。
      entry.onDuty = Boolean(worker.onDuty);
      if (worker.onDuty) {
        entry.highlight.roundRect(-19, -26, 38, 34, 5).stroke({ width: 1.5, color: 0xffc061, alpha: 0.95 });
      } else {
        entry.duty.clear();
      }
      const activity = worker.character?.activity;
      const busy = activity === "working" || activity === "thinking";
      if (busy || entry.busy) entry.lastBusyAt = performance.now();
      entry.busy = busy;
      this.refreshProps(worker.id);
    });

    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      if (entry.transition !== "removing") {
        entry.transition = "removing";
        entry.transitionMs = 0;
        entry.container.eventMode = "none";
        entry.highlight.clear();
        entry.duty.clear();
        entry.onDuty = false;
        entry.props.visible = false;
        entry.notesHit.eventMode = "none";
      }
    }
    return layout;
  }

  private refreshAllProps(): void {
    for (const id of this.entries.keys()) this.refreshProps(id);
  }

  /**
   * Desk props: night lamp (+ a couple of warm pixels on the desk top), the
   * NPC's trinket, sticky notes for queued commands, and the waste bin with
   * today's paper balls. Everything is static — the Graphics is only rebuilt
   * when the visible state key changes, so 20 desks cost nothing per frame.
   */
  private refreshProps(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.transition !== "ready") {
      entry.props.visible = false;
      entry.notesHit.eventMode = "none";
      return;
    }
    entry.props.visible = true;
    const lit = lampLit(this.night, entry.busy, entry.lastBusyAt, performance.now());
    const queued = this.queues.get(id)?.length ?? 0;
    const notes = noteLayout(queued);
    const balls = paperBalls(this.failures.get(id) ?? 0);
    entry.notesHit.eventMode = queued > 0 ? "static" : "none";
    const key = `${lit ? 1 : 0}|${notes.notes.length}|${notes.stacked ? 1 : 0}|${balls.length}`;
    if (key === entry.propsKey) return;
    entry.propsKey = key;
    const g = entry.props;
    g.clear();
    // Desk lamp (left of the monitor): base, post, shade. Off = dark metal only.
    g.rect(-14, -6, 3, 1).fill(0x2c3b59)
      .rect(-13, -10, 1, 4).fill(0x34446a)
      .rect(-13, -11, 3, 1).fill(lit ? 0x6b6450 : 0x3f5072);
    if (lit) {
      // Bulb under the shade and a small warm patch on the desk — squares, never a round glow.
      g.rect(-12, -10, 2, 1).fill({ color: 0xffd9a0, alpha: 0.8 })
        .rect(-13, -5, 4, 1).fill({ color: 0xffcf8a, alpha: 0.26 })
        .rect(-14, -4, 5, 1).fill({ color: 0xffcf8a, alpha: 0.12 });
    }
    for (const [x, y, w, h, color] of trinketPixels(trinketFor(id))) g.rect(x, y, w, h).fill(color);
    // Sticky notes on the monitor's right bezel; a long queue turns the last one into a pad.
    notes.notes.forEach(([x, y, w, h], i) => {
      const last = i === notes.notes.length - 1;
      if (last && notes.stacked) {
        g.rect(x + 1, y - 1, w, h).fill(0x6e6236);
        g.rect(x, y + h, w, 1).fill(0x5f5530);
      }
      g.rect(x, y, w, h).fill(0x9a8848).rect(x, y + h - 1, w, 1).fill(0x857540);
    });
    // Waste-paper bin beside the right desk leg; balls fill it bottom-up to the rim.
    g.rect(14, 7, 6, 1).fill({ color: 0x050810, alpha: 0.3 })
      .rect(15, 2, 4, 4).fill({ color: 0x111827, alpha: 0.85 })
      .rect(14, 1, 6, 1).fill(0x3a4a6c)
      .rect(14, 2, 1, 5).fill(0x2c3b59)
      .rect(19, 2, 1, 5).fill(0x2c3b59)
      .rect(15, 6, 4, 1).fill(0x2c3b59);
    for (const [x, y, w, h] of balls) {
      g.rect(x, y, w, h).fill(0x7d8698).rect(x, y, 1, 1).fill(0x98a0b0);
    }
  }

  update(dt: number): void {
    // Idle lamps go out on their own: a cheap once-a-second check (redraws only on a real change).
    if (this.night) {
      this.lampCheckMs += dt;
      if (this.lampCheckMs >= 1_000) {
        this.lampCheckMs = 0;
        this.refreshAllProps();
      }
    }
    for (const highlight of this.phaseHighlights) {
      const alpha = this.reduceMotion
        ? 0.58
        : 0.42 + 0.24 * (0.5 + 0.5 * Math.sin(performance.now() * 0.006));
      highlight.graphics.clear();
      const color = highlight.phase === "returning" ? 0x37d6a3
        : highlight.phase === "planning" ? 0x8a73e8
        : highlight.phase === "mission_review" || highlight.phase === "mission_consult" ? 0xffb15c
        : highlight.phase === "needs_attention" ? 0xff5c7a
        : 0x4de3ff;
      for (const segment of highlight.segments) {
        highlight.graphics.roundRect(
          segment.left,
          segment.top,
          segment.right - segment.left,
          segment.bottom - segment.top,
          3,
        ).stroke({ width: 1.5, color, alpha });
      }
    }
    for (const [id, entry] of this.entries) {
      // 值勤箭頭動畫：上下浮動＋輕微呼吸亮度，reduce-motion 時退回靜態。
      if (entry.onDuty && entry.transition === "ready") {
        const now = performance.now();
        const bob = this.reduceMotion ? 0 : Math.sin(now * 0.005) * 2.5;
        const glow = this.reduceMotion ? 0.9 : 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(now * 0.005));
        entry.duty.clear();
        entry.duty.poly([-4, -32 + bob, 4, -32 + bob, 0, -27 + bob]).fill({ color: 0xffc061, alpha: glow });
        entry.duty.rect(-1.5, -37 + bob, 3, 4).fill({ color: 0xffc061, alpha: glow * 0.85 });
      } else if (entry.onDuty) {
        entry.duty.clear();
      }
      entry.transitionMs += dt;
      if (entry.transition === "building") {
        const progress = steppedProgress(entry.transitionMs / BUILD_MS);
        this.renderAssembly(entry, progress, false);
        if (entry.transitionMs >= BUILD_MS) {
          entry.transition = "ready";
          this.renderAssembly(entry, 1, false);
          this.refreshProps(id);
        }
        continue;
      }
      if (entry.transition === "removing") {
        const progress = steppedProgress(entry.transitionMs / REMOVE_MS);
        this.renderAssembly(entry, 1 - progress, true);
        if (entry.transitionMs >= REMOVE_MS) {
          entry.container.destroy({ children: true });
          this.entries.delete(id);
        }
      }
    }
  }

  private renderDepartments(departments: DepartmentZone[]): void {
    for (const child of this.departmentLayer.removeChildren()) child.destroy({ children: true });
    this.phaseHighlights = [];
    for (const department of departments) {
      const group = new Container();
      const base = new Graphics();
      // 老闆交辦臨時部門畫成一間「有牆的獨立房間」（暖金色系，與常駐夥伴的冷色地墊區隔），
      // 讓使用者一眼認出這是臨時交辦、又能看到裡面的 NPC 在各自桌上做事。
      const BOSS_ROOM = 0xffc061;
      for (const segment of department.segments) {
        const width = segment.right - segment.left;
        const height = segment.bottom - segment.top;
        if (department.boss) {
          // Walled room: warm-lit floor, a solid enclosing wall, corner posts,
          // and a doorway threshold on the bottom wall (a lighter gap).
          base.roundRect(segment.left, segment.top, width, height, 4)
            .fill({ color: BOSS_ROOM, alpha: 0.11 })
            .stroke({ width: 1.5, color: BOSS_ROOM, alpha: 0.55 });
          base.roundRect(segment.left + 2, segment.top + 2, width - 4, height - 4, 3)
            .stroke({ width: 1, color: BOSS_ROOM, alpha: 0.16 });
          const post = (x: number, y: number) => base.rect(x - 1.5, y - 1.5, 3, 3).fill({ color: BOSS_ROOM, alpha: 0.9 });
          post(segment.left, segment.top);
          post(segment.right, segment.top);
          post(segment.left, segment.bottom);
          post(segment.right, segment.bottom);
          // Doorway: a lighter threshold segment centred on the bottom wall.
          const doorW = Math.min(14, Math.max(8, width * 0.24));
          const doorX = (segment.left + segment.right) / 2 - doorW / 2;
          base.rect(doorX, segment.bottom - 0.5, doorW, 1).fill({ color: 0x0e1526, alpha: 0.9 });
          base.rect(doorX, segment.bottom - 0.5, doorW, 1).fill({ color: BOSS_ROOM, alpha: 0.3 });
        } else if (department.kind === "department") {
          // Quiet floor mat: soft tint, faint border, pixel corner brackets —
          // the architecture should frame the crew, not compete with it.
          base.roundRect(segment.left, segment.top, width, height, 3)
            .fill({ color: department.accent, alpha: 0.08 })
            .stroke({ width: 1, color: department.accent, alpha: 0.22 });
          const bracket = (x: number, y: number, dx: number, dy: number) => {
            base.rect(dx > 0 ? x : x - 4, dy > 0 ? y : y - 1, 4, 1).fill({ color: department.accent, alpha: 0.6 });
            base.rect(dx > 0 ? x : x - 1, dy > 0 ? y : y - 4, 1, 4).fill({ color: department.accent, alpha: 0.6 });
          };
          bracket(segment.left, segment.top, 1, 1);
          bracket(segment.right, segment.top, -1, 1);
          bracket(segment.left, segment.bottom, 1, -1);
          bracket(segment.right, segment.bottom, -1, -1);
        }
        // The shared bench only bridges the desks; a lone desk keeps its own
        // silhouette instead of sprouting a floating shelf across the mat.
        const benchWidth = segment.benchRight - segment.benchLeft;
        base.rect(segment.benchLeft, segment.deskBottom - 5, benchWidth, 4)
          .fill({ color: 0x405274, alpha: 1 });
        base.rect(segment.benchLeft, segment.deskBottom - 5, benchWidth, 1)
          .fill({ color: department.accent, alpha: 0.4 });
      }
      const first = department.segments[0];
      if (!first) continue;
      // A plain floating caption, styled like the furniture labels (no box,
      // no bold, muted color) instead of a bordered pill — the room name is
      // a quiet cue, not a badge competing with the crew for attention.
      const phaseLabel = department.phase === "reviewing"
        ? "REVIEWING"
        : department.phase === "returning" ? "RETURNING"
        : department.phase === "planning" ? "PLANNING"
        : department.phase === "executing" ? "MISSION"
        : department.phase === "mission_review" ? "REVIEW"
        : department.phase === "mission_consult" ? "CONSULT"
        : department.phase === "needs_attention" ? "NEEDS INPUT" : "";
      const suffixParts = [
        department.boss ? t("交辦房 · {count}人", { count: department.memberCount })
          : department.kind === "department" ? t("{count}人", { count: department.memberCount })
          : t("個人工作站"),
        phaseLabel || (department.boss ? "" : this.onDepartmentSelect ? t("交辦") : ""),
      ]
        .filter(Boolean);
      const suffix = suffixParts.length ? ` · ${suffixParts.join(" · ")}` : "";
      const maxTextWidth = first.right - first.left - 4;
      const text = new Text({
        text: `${department.workspaceLabel}${suffix}`,
        style: {
          fill: department.boss
              ? (department.phase === "needs_attention" ? 0xffa24d : 0xffd08a)
            : department.kind === "personal" ? 0x647895
            : department.phase === "returning" ? 0x6fdcb0
            : department.phase === "planning" ? 0xa991ff
            : department.phase === "mission_review" || department.phase === "mission_consult" ? 0xffc87a
            : department.phase === "needs_attention" ? 0xff8298
            : department.phase ? 0x7fd4ec : 0x7b93b8,
          fontSize: 5,
          fontFamily: "'PingFang TC', 'Noto Sans TC', sans-serif",
          fontWeight: "500",
          letterSpacing: 0.2,
        },
      });
      // Rasterize crisp enough for the 4x-and-beyond camera instead of the
      // blurry default that renders 5px glyphs at 1:1.
      text.resolution = 4;
      let keep = department.workspaceLabel.length;
      while (text.width > maxTextWidth && keep > 1) {
        keep--;
        text.text = `${department.workspaceLabel.slice(0, keep)}…${suffix}`;
      }
      text.alpha = department.boss ? 0.92 : department.kind === "personal" ? 0.58 : 0.8;
      text.anchor.set(0.5, 1);
      text.position.set((first.left + first.right) / 2, first.top - 2);
      group.addChild(base, text);
      if (this.onDepartmentSelect) {
        // The caption is the department-level action surface. Keeping the hit
        // target above the mat avoids stealing clicks from NPCs and desks.
        const labelWidth = Math.min(first.right - first.left, Math.max(34, text.width + 10));
        const sign = new Graphics()
          .roundRect((first.left + first.right - labelWidth) / 2, first.top - 11, labelWidth, 11, 3)
          .fill({ color: department.accent, alpha: 0.001 });
        sign.eventMode = "static";
        sign.cursor = "pointer";
        // Open on a real tap, not pointertap — Pixi's tap tolerance is generous
        // enough that a small pan over the sign still fired, which is exactly the
        // accidental "直接交辦" dialog on phones. Guard with the shared drag flag.
        let signPid = -1;
        sign.on("pointerdown", (event) => { signPid = event.pointerId; });
        sign.on("pointerup", (event) => {
          if (event.pointerId !== signPid) return;
          signPid = -1;
          if (this.isDragging()) return;
          event.stopPropagation();
          this.onDepartmentSelect?.(department.workspacePath);
        });
        group.addChild(sign);

        if (department.kind === "department" && !department.boss && this.onDepartmentRename) {
          const pencil = new Text({
            text: "✎",
            style: {
              fill: 0x8fa7c3,
              fontSize: 6,
              fontFamily: "sans-serif",
              fontWeight: "600",
            },
          });
          pencil.resolution = 4;
          pencil.anchor.set(0, 1);
          pencil.position.set((first.left + first.right) / 2 + text.width / 2 + 3, first.top - 2);
          pencil.eventMode = "static";
          pencil.cursor = "pointer";
          pencil.on("pointerover", () => { pencil.style.fill = 0x4de3ff; });
          pencil.on("pointerout", () => { pencil.style.fill = 0x8fa7c3; });
          let pencilPid = -1;
          pencil.on("pointerdown", (event) => { pencilPid = event.pointerId; });
          pencil.on("pointerup", (event) => {
            if (event.pointerId !== pencilPid) return;
            pencilPid = -1;
            if (this.isDragging()) return;
            event.stopPropagation();
            this.onDepartmentRename?.(department.workspacePath, { x: event.global.x, y: event.global.y });
          });
          group.addChild(pencil);
        }
      }
      if (department.missionProgress && department.missionProgress.total > 0) {
        const rail = new Graphics();
        const width = Math.max(12, first.right - first.left - 10);
        const ratio = Math.max(0, Math.min(1, department.missionProgress.completed / department.missionProgress.total));
        rail.rect(first.left + 5, first.bottom - 3, width, 1).fill({ color: 0x243653, alpha: 0.9 });
        rail.rect(first.left + 5, first.bottom - 3, Math.max(1, Math.round(width * ratio)), 1).fill({ color: department.phase === "needs_attention" ? 0xff5c7a : 0x4de3ff, alpha: 0.9 });
        group.addChild(rail);
      }
      if (department.phase) {
        const graphics = new Graphics();
        group.addChild(graphics);
        this.phaseHighlights.push({ graphics, segments: department.segments, phase: department.phase });
      }
      this.departmentLayer.addChild(group);
    }
  }

  private renderAssembly(entry: DeskEntry, progress: number, removing: boolean): void {
    const reveal = progress * entry.parts.length;
    entry.parts.forEach((part, index) => {
      const local = Math.max(0, Math.min(1, reveal - index));
      part.visible = local > 0;
      part.alpha = local;
      part.y = Math.round((1 - local) * -3);
    });

    entry.container.alpha = 1;
    entry.blueprint.visible = progress < 1;
    entry.blueprint.alpha = Math.max(0, Math.min(0.34, removing
      ? (1 - progress) * 0.48
      : 0.28 - progress * 0.2));
    entry.effect.visible = progress > 0 && progress < 1;
    entry.effect.clear();
    if (entry.effect.visible) {
      const scanY = -20 + Math.floor((entry.transitionMs / 55) % 24);
      entry.effect.rect(-13, scanY, 26, 1).fill({ color: 0x4de3ff, alpha: 0.22 });
      const direction = removing ? -1 : 1;
      for (let i = 0; i < 3; i++) {
        const phase = Math.floor(entry.transitionMs / 85 + i * 3) % 10;
        const x = -10 + phase * 2;
        const y = -5 - ((phase * direction + i * 4 + 20) % 14);
        entry.effect.rect(x, y, 1, 1).fill({
          color: i === 1 ? 0x37d6a3 : 0x4de3ff,
          alpha: 0.45 + i * 0.15,
        });
      }
    }
  }

  private createDesk(worker: PersonalDeskState): DeskEntry {
    const container = new Container();
    const highlight = new Graphics();
    const blueprint = new Graphics();
    const effect = new Graphics();
    const color = SHIRT_COLORS[worker.colorIndex % SHIRT_COLORS.length]?.[0] ?? 0x4de3ff;

    // Contact shadow under the desk ties it to the floor; the legs carry a 1px
    // shaded inner edge so they read as posts, not flat bars.
    const legs = new Graphics()
      .rect(-13, 6, 26, 1).fill({ color: 0x050810, alpha: 0.45 })
      .rect(-11, 7, 22, 1).fill({ color: 0x050810, alpha: 0.18 })
      .rect(-12, -1, 3, 7).fill(0x293956)
      .rect(9, -1, 3, 7).fill(0x293956)
      .rect(-10, -1, 1, 7).fill(0x1f2c45)
      .rect(11, -1, 1, 7).fill(0x1f2c45);
    // Desk top with a lit front edge and a shaded underside, plus a little keyboard.
    const desktop = new Graphics()
      .rect(-14, -5, 28, 4).fill(0x405274)
      .rect(-14, -2, 28, 1).fill(0x4b5f85)
      .rect(-14, -1, 28, 1).fill(0x2c3b59)
      .rect(-5, -4, 8, 1).fill(0x566a91)
      .rect(-5, -3, 8, 1).fill(0x34446a)
      .rect(10, -4, 2, 1).fill(color);
    const monitorStand = new Graphics()
      .rect(-1, -9, 2, 3).fill(0x415477)
      .rect(-4, -6, 8, 2).fill(0x415477)
      .rect(-4, -6, 8, 1).fill(0x4b5f85);
    // Bezel with a lighter top lip and a tiny dim power LED.
    const monitor = new Graphics()
      .rect(-8, -19, 16, 10).fill(0x334468)
      .rect(-8, -19, 16, 1).fill(0x3f5480)
      .rect(-6, -17, 12, 6).fill(0x08101f)
      .rect(6, -10, 1, 1).fill({ color: 0x37d6a3, alpha: 0.55 });
    const screen = new Graphics()
      .rect(-4, -15, 5, 2).fill({ color, alpha: 0.9 })
      .rect(2, -15, 2, 2).fill(0x37d6a3);
    const parts = [legs, desktop, monitorStand, monitor, screen];

    blueprint.roundRect(-15, -22, 30, 28, 3).stroke({ width: 1, color: 0x4de3ff });
    blueprint.rect(-7, -18, 14, 8).stroke({ width: 1, color: 0x37d6a3 });
    blueprint.rect(-13, -4, 26, 1).fill(0x4de3ff);

    container.zIndex = 160;
    container.eventMode = "static";
    container.cursor = "pointer";
    container.hitArea = {
      contains: (x: number, y: number) => x >= -16 && x <= 16 && y >= -23 && y <= 7,
    };
    // Select on a real tap, not pointerdown — dragging the map from on top of a
    // desk must pan, not select (which would open the task log). See scene.ts.
    let deskPid = -1;
    container.on("pointerdown", (event) => { deskPid = event.pointerId; });
    container.on("pointerup", (event) => {
      if (event.pointerId !== deskPid) return;
      deskPid = -1;
      if (!this.isDragging()) this.onSelect(worker.id);
    });
    const duty = new Graphics();
    const props = new Graphics();
    props.visible = false;
    // Sticky-note tap target: a child of the desk, so it is hit-tested before the
    // desk itself; stopping propagation keeps the tap from also selecting the NPC.
    const notesHit = new Container();
    notesHit.eventMode = "none";
    notesHit.cursor = "pointer";
    notesHit.hitArea = {
      contains: (x: number, y: number) => noteHit(x, y, this.queues.get(worker.id)?.length ?? 0),
    };
    let notesPid = -1;
    notesHit.on("pointerdown", (event) => { notesPid = event.pointerId; });
    notesHit.on("pointerup", (event) => {
      if (event.pointerId !== notesPid) return;
      notesPid = -1;
      event.stopPropagation();
      if (this.isDragging()) return;
      const items = this.queues.get(worker.id);
      if (!items?.length) return;
      this.onQueueNotesTap?.({
        id: worker.id,
        items: items.slice(0, 3),
        card: queueCard(items),
        global: { x: event.global.x, y: event.global.y },
      });
    });
    container.addChild(highlight, blueprint, ...parts, props, effect, duty, notesHit);
    for (const part of parts) part.visible = false;
    return {
      container,
      highlight,
      blueprint,
      effect,
      duty,
      onDuty: false,
      parts,
      transition: "building",
      transitionMs: 0,
      props,
      notesHit,
      propsKey: "",
      busy: false,
      lastBusyAt: null,
    };
  }
}
