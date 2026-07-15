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
};

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
      entry.container.destroy({ children: true });
      this.entries.delete(id);
    }
  }

  private createDesk(worker: PersonalDeskState): DeskEntry {
    const container = new Container();
    const highlight = new Graphics();
    const furniture = new Graphics();
    const color = SHIRT_COLORS[worker.colorIndex % SHIRT_COLORS.length]?.[0] ?? 0x4de3ff;

    // Pixel monitor, desktop and legs.
    furniture.rect(-8, -19, 16, 10).fill(0x334468);
    furniture.rect(-6, -17, 12, 6).fill(0x08101f);
    furniture.rect(-4, -15, 5, 2).fill({ color, alpha: 0.9 });
    furniture.rect(2, -15, 2, 2).fill(0x37d6a3);
    furniture.rect(-1, -9, 2, 3).fill(0x415477);
    furniture.rect(-4, -6, 8, 2).fill(0x415477);
    furniture.rect(-14, -5, 28, 4).fill(0x405274);
    furniture.rect(-12, -1, 3, 7).fill(0x293956);
    furniture.rect(9, -1, 3, 7).fill(0x293956);
    furniture.rect(10, -4, 2, 1).fill(color);

    container.zIndex = 160;
    container.eventMode = "static";
    container.cursor = "pointer";
    container.hitArea = {
      contains: (x: number, y: number) => x >= -16 && x <= 16 && y >= -23 && y <= 7,
    };
    container.on("pointerdown", () => this.onSelect(worker.id));
    container.addChild(highlight, furniture);
    return { container, highlight };
  }
}
