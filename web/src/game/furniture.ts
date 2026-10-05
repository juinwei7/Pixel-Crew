import { Container, Graphics, Sprite } from "pixi.js";
import type { StationKey } from "../stations";
import { PAL, texFromMap } from "./pixels";
import { FURNITURE_DEFS, type FurnitureDef } from "./furnitureDefs";

export { FURNITURE_DEFS, type FurnitureDef };

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const POKE_MS = 1_300;

class FurnitureSprite {
  readonly container = new Container();
  private readonly ledOverlay = new Graphics();
  private readonly highlight = new Graphics();
  /** Click reactions + the hover outline. */
  private readonly fxG = new Graphics();
  active = false;
  hovered = false;
  private pokeT = 0;
  private lastT = 0;
  private readonly w: number;
  private readonly h: number;

  constructor(readonly def: FurnitureDef) {
    const sprite = new Sprite(texFromMap(def.map, PAL));
    this.w = def.map[0].length;
    this.h = def.map.length;
    sprite.anchor.set(0.5, 1);
    this.container.addChild(this.highlight, sprite, this.ledOverlay, this.fxG);
    this.container.position.set(def.x, def.bottom);
    this.container.zIndex = def.key === "home" ? def.bottom - 10 : def.bottom;
  }

  /** Clicked: the shelf drops a book, the board loses a sticky note, anything else bounces and sparks. */
  poke(): void {
    this.pokeT = POKE_MS;
  }

  update(tMs: number): void {
    const dt = Math.min(100, Math.max(0, tMs - this.lastT));
    this.lastT = tMs;
    this.drawPoke(dt);
    const g = this.ledOverlay;
    g.clear();
    const hl = this.highlight;
    hl.clear();

    if (!this.active) return;

    // Blinking LEDs
    for (let i = 0; i < this.def.leds.length; i++) {
      const led = this.def.leds[i];
      const on = Math.floor(tMs / 180 + i) % 2 === 0;
      g.rect(led.x - this.w / 2, led.y - this.h, 2, 2).fill({
        color: on ? 0x4de3ff : 0x37d6a3,
        alpha: on ? 1 : 0.5,
      });
    }

    // Pulsing outline under the furniture
    const pulse = 0.5 + 0.5 * Math.sin(tMs * 0.006);
    hl.ellipse(0, 1, this.w / 2 + 3, 3.5).stroke({
      width: 1,
      color: 0x4de3ff,
      alpha: 0.35 + 0.4 * pulse,
    });
  }

  private drawPoke(dt: number): void {
    const g = this.fxG;
    g.clear();
    const left = -this.w / 2;
    const top = -this.h;
    if (this.hovered) g.rect(left - 1, top - 1, this.w + 2, this.h + 2).stroke({ color: 0xdfe9f8, width: 0.5, alpha: 0.5 });
    this.container.scale.y = 1;
    if (this.pokeT <= 0) return;
    this.pokeT -= dt;
    const p = 1 - Math.max(0, this.pokeT) / POKE_MS;
    if (REDUCE_MOTION) return;
    if (this.def.key === "books") {
      // A book slides off the shelf, flops on the floor, then hops back in.
      g.rect(left + 2, top + 2, 2, 2).fill(0x101828);
      const [x, y, flat] = fallPath(p, left + 2, top + 2, 2);
      if (flat) g.rect(x - 0.5, y + 1, 3, 1.5).fill(0xf29e4c);
      else g.rect(x, y, 2, 2).fill(0xf29e4c);
      if (p > 0.92) this.sparkle(g, left + 3, top + 3, (p - 0.92) / 0.08);
    } else if (this.def.key === "board") {
      // A sticky note peels off and flutters down, then gets pinned back.
      g.rect(left + 14, top + 3, 2, 1).fill(0x101828);
      const [x, y] = fallPath(p, left + 14, top + 3, 3);
      g.rect(x + Math.round(Math.sin(p * 20) * 0.8), y, 2, 2).fill(0xffd166);
      if (p > 0.92) this.sparkle(g, left + 15, top + 3, (p - 0.92) / 0.08);
    } else {
      // Bounce + a little burst of sparks off the top.
      this.container.scale.y = 1 + Math.sin(p * Math.PI * 4) * 0.07 * (1 - p);
      if (p < 0.6) this.sparkle(g, 0, top - 1, p / 0.6);
    }
  }

  private sparkle(g: Graphics, x: number, y: number, q: number): void {
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.6;
      g.rect(Math.round(x + Math.cos(a) * (2 + q * 5)), Math.round(y + Math.sin(a) * (2 + q * 4)), 1, 1)
        .fill({ color: 0xfff3c4, alpha: 1 - q });
    }
  }
}

export class FurnitureLayer {
  readonly container = new Container();
  private readonly sprites = new Map<StationKey, FurnitureSprite>();

  constructor(
    private readonly onHover: (key: StationKey | null) => void = () => {},
    private readonly onSelect: (key: StationKey) => void = () => {},
  ) {
    this.container.sortableChildren = true;
    for (const def of FURNITURE_DEFS) {
      const sprite = new FurnitureSprite(def);
      // Invisible rendezvous/home spots (empty label) aren't real furniture —
      // nothing for the user to point at or click.
      if (def.label) {
        sprite.container.eventMode = "static";
        sprite.container.cursor = "pointer";
        // Touch has no hover: a finger dragging across furniture while panning
        // fires pointerover and would pop tooltips mid-swipe. Mouse hovers only;
        // touch users tap (pointertap below) to pin a station's info instead.
        sprite.container.on("pointerover", (e) => {
          if (e.pointerType === "touch") return;
          sprite.hovered = true;
          this.onHover(def.key);
        });
        sprite.container.on("pointerout", (e) => {
          if (e.pointerType === "touch") return;
          sprite.hovered = false;
          this.onHover(null);
        });
        // Fire only on a genuine tap (down + up with negligible movement), not on
        // pointerdown — otherwise starting a pan/swipe over the war-room table on a
        // phone instantly opened the roundtable. A drag past ~10px counts as a pan.
        let dx = 0, dy = 0, dpid = -1;
        sprite.container.on("pointerdown", (e) => { dx = e.global.x; dy = e.global.y; dpid = e.pointerId; });
        sprite.container.on("pointerup", (e) => {
          if (e.pointerId !== dpid) return;
          dpid = -1;
          if (Math.hypot(e.global.x - dx, e.global.y - dy) <= 10) {
            sprite.poke(); // visual only; the existing station click carries on as before
            this.onSelect(def.key);
          }
        });
      }
      this.sprites.set(def.key, sprite);
      this.container.addChild(sprite.container);
    }
  }

  def(key: StationKey): FurnitureDef {
    return this.sprites.get(key)?.def ?? FURNITURE_DEFS[FURNITURE_DEFS.length - 1];
  }

  setActive(keys: ReadonlySet<StationKey>): void {
    for (const [k, sprite] of this.sprites) sprite.active = keys.has(k);
  }

  update(tMs: number): void {
    for (const sprite of this.sprites.values()) sprite.update(tMs);
  }
}

/**
 * Path of something knocked off a shelf: falls to the floor below (fall),
 * lies there, then hops back up into its slot. Returns [x, y, lyingFlat].
 */
function fallPath(p: number, x0: number, y0: number, drift: number): [number, number, boolean] {
  const floor = 2;
  if (p < 0.3) {
    const q = p / 0.3;
    return [x0 + q * drift, y0 + q * q * (floor - y0), q > 0.7];
  }
  if (p < 0.65) return [x0 + drift, floor - (p < 0.38 ? Math.sin(((p - 0.3) / 0.08) * Math.PI) * 1.5 : 0), true];
  if (p < 0.92) {
    const q = (p - 0.65) / 0.27;
    return [x0 + drift * (1 - q), floor + (y0 - floor) * q - Math.sin(q * Math.PI) * 6, false];
  }
  return [x0, y0, false];
}
