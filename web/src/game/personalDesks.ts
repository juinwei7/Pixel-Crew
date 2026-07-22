import { Container, Graphics, Text } from "pixi.js";
import { SHIRT_COLORS } from "./person";
import { ART_W } from "./room";

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
};

type DeskEntry = {
  container: Container;
  highlight: Graphics;
  blueprint: Graphics;
  effect: Graphics;
  parts: Graphics[];
  transition: "building" | "ready" | "removing";
  transitionMs: number;
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

  const budget = ART_W - ROW_MARGIN * 2;
  type Chunk = { members: PersonalDeskState[]; left: number };
  const rows: Array<{ width: number; chunks: Chunk[] }> = [];
  for (const members of groups.values()) {
    for (let start = 0; start < members.length; start += DEPARTMENT_SEAT_COLUMNS) {
      const chunkMembers = members.slice(start, start + DEPARTMENT_SEAT_COLUMNS);
      const width = zoneWidth(chunkMembers.length);
      let row = rows[rows.length - 1];
      if (!row || (row.chunks.length > 0 && row.width + DEPT_GAP + width > budget)) {
        row = { width: 0, chunks: [] };
        rows.push(row);
      }
      const left = row.chunks.length > 0 ? row.width + DEPT_GAP : 0;
      row.chunks.push({ members: chunkMembers, left });
      row.width = left + width;
    }
  }

  // Rows sit at the upper third of the department band instead of clinging to
  // its top edge, so a small crew doesn't leave a huge dead floor below.
  const extent = rows.length ? (rows.length - 1) * ROW_PITCH + ZONE_TOP + ZONE_BOTTOM : 0;
  const firstRowY = BAND_TOP + ZONE_TOP + Math.max(0, Math.floor((BAND_BOTTOM - BAND_TOP - extent) / 3));

  rows.forEach((row, rowIndex) => {
    const offset = ROW_MARGIN + Math.floor((budget - row.width) / 2);
    const y = firstRowY + rowIndex * ROW_PITCH;
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
    return {
      kind: members.length >= 2 ? "department" : "personal",
      workspacePath: departmentKey,
      workspaceLabel: members[0].workspaceLabel,
      memberCount: members.length,
      phase,
      missionProgress,
      accent: workspaceAccent(departmentKey),
      segments,
    };
  });

  return { seats, departments };
}

export class PersonalDeskLayer {
  readonly container = new Container();
  private readonly departmentLayer = new Container();
  private readonly deskLayer = new Container();
  private readonly entries = new Map<string, DeskEntry>();
  private phaseHighlights: PhaseHighlight[] = [];
  private readonly reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private readonly onSelect: (id: string) => void,
    private readonly onDepartmentSelect?: (workspacePath: string) => void,
  ) {
    this.container.sortableChildren = true;
    this.departmentLayer.zIndex = -10;
    this.deskLayer.sortableChildren = true;
    this.container.addChild(this.departmentLayer, this.deskLayer);
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
    });

    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      if (entry.transition !== "removing") {
        entry.transition = "removing";
        entry.transitionMs = 0;
        entry.container.eventMode = "none";
        entry.highlight.clear();
      }
    }
    return layout;
  }

  update(dt: number): void {
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
      entry.transitionMs += dt;
      if (entry.transition === "building") {
        const progress = steppedProgress(entry.transitionMs / BUILD_MS);
        this.renderAssembly(entry, progress, false);
        if (entry.transitionMs >= BUILD_MS) {
          entry.transition = "ready";
          this.renderAssembly(entry, 1, false);
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
      for (const segment of department.segments) {
        const width = segment.right - segment.left;
        const height = segment.bottom - segment.top;
        // Quiet floor mat: soft tint, faint border, pixel corner brackets —
        // the architecture should frame the crew, not compete with it.
        if (department.kind === "department") {
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
        department.kind === "department" ? `${department.memberCount}人` : "個人工作站",
        phaseLabel || (this.onDepartmentSelect ? "交辦" : ""),
      ]
        .filter(Boolean);
      const suffix = suffixParts.length ? ` · ${suffixParts.join(" · ")}` : "";
      const maxTextWidth = first.right - first.left - 4;
      const text = new Text({
        text: `${department.workspaceLabel}${suffix}`,
        style: {
          fill: department.kind === "personal" ? 0x647895
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
      text.alpha = department.kind === "personal" ? 0.58 : 0.8;
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
        sign.on("pointertap", () => this.onDepartmentSelect?.(department.workspacePath));
        group.addChild(sign);
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

    const legs = new Graphics()
      .rect(-12, -1, 3, 7).fill(0x293956)
      .rect(9, -1, 3, 7).fill(0x293956);
    const desktop = new Graphics()
      .rect(-14, -5, 28, 4).fill(0x405274)
      .rect(10, -4, 2, 1).fill(color);
    const monitorStand = new Graphics()
      .rect(-1, -9, 2, 3).fill(0x415477)
      .rect(-4, -6, 8, 2).fill(0x415477);
    const monitor = new Graphics()
      .rect(-8, -19, 16, 10).fill(0x334468)
      .rect(-6, -17, 12, 6).fill(0x08101f);
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
    container.on("pointerdown", () => this.onSelect(worker.id));
    container.addChild(highlight, blueprint, ...parts, effect);
    for (const part of parts) part.visible = false;
    return {
      container,
      highlight,
      blueprint,
      effect,
      parts,
      transition: "building",
      transitionMs: 0,
    };
  }
}
