import { Container, Graphics } from "pixi.js";
import { ART_W } from "./room";
import { SHIRT_COLORS } from "./person";

export type PersonalDeskState = {
  id: string;
  name: string;
  colorIndex: number;
  active: boolean;
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

const BUILD_MS = 980;
const REMOVE_MS = 720;

function steppedProgress(value: number, steps = 8): number {
  return Math.floor(Math.max(0, Math.min(1, value)) * steps) / steps;
}

/** Evenly distribute personal desks across the bottom row of the office. */
export function personalDeskSpot(index: number, count: number): {
  x: number;
  y: number;
  deskBottom: number;
} {
  if (count <= 1) return { x: ART_W / 2, y: 174, deskBottom: 160 };
  if (count <= 4) {
    const gap = 44;
    return {
      x: Math.round(ART_W / 2 + (index - (count - 1) / 2) * gap),
      y: 150,
      deskBottom: 137,
    };
  }
  const backCount = Math.ceil(count / 2);
  const backRow = index < backCount;
  const rowIndex = backRow ? index : index - backCount;
  const rowCount = backRow ? backCount : count - backCount;
  const maxGap = count <= 8 ? 44 : 30;
  const gap = Math.min(maxGap, 280 / Math.max(1, rowCount - 1));
  const x = ART_W / 2 + (rowIndex - (rowCount - 1) / 2) * gap;
  return {
    x: Math.round(x),
    y: backRow ? 126 : 174,
    deskBottom: backRow ? 113 : 160,
  };
}

export class PersonalDeskLayer {
  readonly container = new Container();
  private readonly entries = new Map<string, DeskEntry>();

  constructor(private readonly onSelect: (id: string) => void) {
    this.container.sortableChildren = true;
  }

  setWorkers(workers: PersonalDeskState[]): void {
    const seen = new Set<string>();
    workers.forEach((worker, index) => {
      seen.add(worker.id);
      let entry = this.entries.get(worker.id);
      if (!entry) {
        entry = this.createDesk(worker);
        this.entries.set(worker.id, entry);
        this.container.addChild(entry.container);
      } else if (entry.transition === "removing") {
        entry.transition = "building";
        entry.transitionMs = BUILD_MS * 0.35;
        entry.container.eventMode = "static";
      }
      const spot = personalDeskSpot(index, workers.length);
      entry.container.position.set(spot.x, spot.deskBottom);
      entry.container.zIndex = spot.deskBottom;
      entry.highlight.clear();
      if (worker.active) {
        entry.highlight.roundRect(-15, -23, 30, 27, 4).stroke({
          width: 1,
          color: SHIRT_COLORS[worker.colorIndex % SHIRT_COLORS.length]?.[0] ?? 0x4de3ff,
          alpha: 0.55,
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
  }

  update(dt: number): void {
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

    // A quiet cyan blueprint belongs to the existing office palette and
    // communicates intent without looking like a construction-site barrier.
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
