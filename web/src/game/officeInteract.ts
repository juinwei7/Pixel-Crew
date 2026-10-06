import { Container, Graphics } from "pixi.js";
import type { Rect } from "./officeFx";

// Click-to-play bits of the office: invisible hit boxes over decor (clock,
// poster, plants, coffee machine…) that show a faint outline on hover and
// play a purely visual reaction on a tap, plus the little ripple left on the
// floor where you click. Nothing here selects, opens or sends anything.

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type Hotspot = {
  key: string;
  rect: Rect;
  /** Depth for hit-testing against people / desks (wall items sit far back). */
  z: number;
  poke(): void;
  /** Only interactive while this returns true (e.g. the neon sign exists). */
  enabled?(): boolean;
};

type Options = {
  /** A press that turned into a pan is not a tap. */
  isDragging?: () => boolean;
  onHover?: (key: string | null) => void;
  /** After the reaction plays (the scene uses it to keep "tap empty space closes the log"). */
  onTap?: (key: string) => void;
};

export class Hotspots {
  /** Hover outline, above the decor. */
  readonly hoverG = new Graphics();
  private readonly items: Array<{ spot: Hotspot; c: Container }> = [];
  private hovered: Hotspot | null = null;

  constructor(parent: Container, spots: Hotspot[], private readonly opts: Options = {}) {
    this.hoverG.zIndex = 9_400;
    this.hoverG.eventMode = "none";
    parent.addChild(this.hoverG);
    for (const spot of spots) {
      const c = new Container();
      const { x, y, w, h } = spot.rect;
      c.zIndex = spot.z;
      c.eventMode = "static";
      c.cursor = "pointer";
      c.hitArea = { contains: (px: number, py: number) => px >= x && px < x + w && py >= y && py < y + h };
      let pid = -1;
      c.on("pointerdown", (e) => { pid = e.pointerId; });
      c.on("pointerup", (e) => {
        if (e.pointerId !== pid) return;
        pid = -1;
        if (opts.isDragging?.()) return;
        spot.poke();
        opts.onTap?.(spot.key);
      });
      c.on("pointerover", (e) => {
        if (e.pointerType === "touch") return;
        this.hovered = spot;
        opts.onHover?.(spot.key);
      });
      c.on("pointerout", () => {
        if (this.hovered === spot) this.hovered = null;
        opts.onHover?.(null);
      });
      parent.addChild(c);
      this.items.push({ spot, c });
    }
  }

  update(): void {
    for (const { spot, c } of this.items) c.eventMode = !spot.enabled || spot.enabled() ? "static" : "none";
    const h = this.hovered;
    if (h !== this.drawnFor) {
      this.drawnFor = h;
      this.hoverAt = performance.now();
    }
    const g = this.hoverG;
    g.clear();
    if (!h || (h.enabled && !h.enabled())) return;
    // Corner brackets rather than a full box: reads as "this is clickable" without boxing the art in.
    hoverBrackets(g, h.rect, performance.now() - this.hoverAt);
  }

  private drawnFor: Hotspot | null = null;
  private hoverAt = 0;

  destroy(): void {
    for (const { c } of this.items) c.destroy();
    this.hoverG.destroy();
  }
}

/** Brackets slide in from 2px out and fade up over this long, then sit still. */
const HOVER_IN_MS = 140;

/**
 * Hover corner brackets on whole art pixels (crisp, like the rest of the art).
 * `sinceMs` is how long the pointer has been over the thing: the brackets
 * close in from a couple of pixels out and fade up once, then stay put.
 */
export function hoverBrackets(g: Graphics, rect: Rect, sinceMs: number): void {
  const p = REDUCE_MOTION ? 1 : Math.min(1, Math.max(0, sinceMs) / HOVER_IN_MS);
  const e = 1 - (1 - p) * (1 - p);
  const off = Math.round((1 - e) * 2);
  const x = rect.x - 1 - off;
  const y = rect.y - 1 - off;
  const w = rect.w + 2 + off * 2;
  const h = rect.h + 2 + off * 2;
  const c = { color: 0xdfe9f8, alpha: 0.5 * e };
  const L = 3;
  // Each corner: a 3px arm along each edge, sharing the corner pixel.
  g.rect(x, y, L, 1).fill(c).rect(x, y + 1, 1, L - 1).fill(c);
  g.rect(x + w - L, y, L, 1).fill(c).rect(x + w - 1, y + 1, 1, L - 1).fill(c);
  g.rect(x, y + h - 1, L, 1).fill(c).rect(x, y + h - L, 1, L - 1).fill(c);
  g.rect(x + w - L, y + h - 1, L, 1).fill(c).rect(x + w - 1, y + h - L, 1, L - 1).fill(c);
}

type Ripple = { x: number; y: number; t: number };
const RIPPLE_MS = 650;

/** A small pixel ripple and a puff of dust where the floor was tapped. */
export class FloorRipples {
  readonly g = new Graphics();
  private list: Ripple[] = [];

  constructor() {
    // On the floor: above tiles and desk mats, below people and furniture.
    this.g.zIndex = 1;
    this.g.eventMode = "none";
  }

  add(x: number, y: number): void {
    if (this.list.length >= 4) this.list.shift();
    this.list.push({ x: Math.round(x), y: Math.round(y), t: 0 });
  }

  update(dtMs: number): void {
    const g = this.g;
    g.clear();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      r.t += dtMs;
      const p = r.t / RIPPLE_MS;
      if (p >= 1) {
        this.list.splice(i, 1);
        continue;
      }
      const fade = 1 - p;
      if (REDUCE_MOTION) {
        g.ellipse(r.x, r.y, 4, 1.4).stroke({ color: 0x9ff3ff, width: 0.6, alpha: 0.6 * fade });
        continue;
      }
      // Two pixel rings spreading out across the tiles (flattened for the floor's perspective).
      for (const [delay, color] of [[0, 0x9ff3ff], [0.25, 0x4de3ff]] as Array<[number, number]>) {
        const q = (p - delay) / (1 - delay);
        if (q <= 0) continue;
        const rx = 2 + q * 9;
        const n = 12;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          g.rect(Math.round(r.x + Math.cos(a) * rx), Math.round(r.y + Math.sin(a) * rx * 0.36), 1, 1)
            .fill({ color, alpha: 0.75 * (1 - q) });
        }
      }
      // Dust kicked up.
      for (let k = 0; k < 4; k++) {
        const a = -Math.PI / 2 + (k - 1.5) * 0.55;
        const d = 1 + p * 5;
        g.rect(Math.round(r.x + Math.cos(a) * d), Math.round(r.y - 1 + Math.sin(a) * d * 0.8 + p * p * 3), 1, 1)
          .fill({ color: 0xb8c2d6, alpha: 0.7 * fade });
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
