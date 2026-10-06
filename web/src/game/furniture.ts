import { CanvasTextMetrics, Container, Graphics, Sprite, TextStyle } from "pixi.js";
import type { StationKey } from "../stations";
import { PAL, texFromMap, type Palette } from "./pixels";
import { FURNITURE_DEFS, type FurnitureDef } from "./furnitureDefs";
import { STATION_THEME } from "../stationTheme";

export { FURNITURE_DEFS, type FurnitureDef };

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const POKE_MS = 1_300;
/** A station lights up / goes dark over this long (ease-out), instead of snapping. */
const GLOW_MS = 200;
/** 其他工具 has no STATION_THEME entry; same fallback tint as its NPC activity chip. */
const DEFAULT_ACCENT = 0x8fb6ff;
const easeOut = (p: number) => 1 - (1 - p) ** 3;

// Shared station kit: one casing / screen palette for every tool station, plus
// A (accent) and q (dimmed accent) filled in per station.
const CASE = 0x3a4a72;
const CASE_SHADE = 0x27324f;
const CASE_EDGE = 0x6a80ad;
const SCREEN = 0x0c1322;
const KIT: Palette = { ...PAL, K: CASE, k: CASE_SHADE, L: CASE_EDGE, X: SCREEN };

function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return ch(16) | ch(8) | ch(0);
}

// The shared counter the tool stations stand on (art px). Device sprites end
// on its top surface; their label plates hang just below its front.
const COUNTER_TOP = 52; // flush with the wall base
const COUNTER_FRONT = 60;
const COUNTER_BOTTOM = 68;
const COUNTER = {
  top: 0x283554,
  edge: 0x3a4b72,
  lip: 0x141c30,
  face: 0x1b253f,
  panel: 0x222e4b,
  seam: 0x111829,
  toe: 0x121a2c,
};
/** Half-width of one station's stretch of counter (stations sit ~54px apart). */
const SECTION_HALF = 24;

// Station label plates sit behind the station-name text the scene draws in
// screen space (12px, top-anchored at the furniture bottom + 3 art px), so they
// are sized in screen pixels and re-laid out whenever the camera zoom changes.
const LABEL_STYLE = new TextStyle({ fontSize: 12, fontFamily: "'PingFang TC', 'Noto Sans TC', sans-serif", letterSpacing: 1 });
const PLATE = { padL: 15, padR: 7, padY: 2, dot: 3, dotX: 6, fill: 0x0b111e, rule: 0x263452, ruleHover: 0x3a4c72 };

class FurnitureSprite {
  readonly container = new Container();
  private readonly ledOverlay = new Graphics();
  private readonly highlight = new Graphics();
  private readonly plate = new Graphics();
  /** Click reactions + the hover outline. */
  private readonly fxG = new Graphics();
  active = false;
  hovered = false;
  private pokeT = 0;
  /** 0 = dark, 1 = fully lit; walks toward `active` over GLOW_MS. */
  private glow = 0;
  /** The station's own theme colour, shared with the NPC card's work window. */
  private readonly accent: number;
  /** The accent dimmed toward the screen colour (the kit q). */
  private readonly dim: number;
  private lastT = 0;
  private readonly w: number;
  private readonly h: number;
  private readonly labelSize: { w: number; h: number } | null;
  private plateKey = "";

  constructor(readonly def: FurnitureDef) {
    const themed = STATION_THEME[def.key]?.accent;
    this.accent = themed ? parseInt(themed.slice(1), 16) : DEFAULT_ACCENT;
    this.dim = mix(this.accent, SCREEN, 0.45);
    const palette: Palette = def.counter || def.onWall ? { ...KIT, A: this.accent, q: this.dim } : PAL;
    const sprite = new Sprite(texFromMap(def.map, palette));
    this.w = def.map[0].length;
    this.h = def.map.length;
    sprite.anchor.set(0.5, 1);
    this.container.addChild(this.plate, this.highlight, sprite, this.ledOverlay, this.fxG);
    this.container.position.set(def.x, def.bottom);
    this.container.zIndex = def.key === "home" ? def.bottom - 10 : def.bottom;
    if (def.label) {
      const m = CanvasTextMetrics.measureText(def.label, LABEL_STYLE);
      this.labelSize = { w: m.width, h: m.height };
    } else this.labelSize = null;
  }

  /** Clicked: the shelf drops a book, the board loses a sticky note, anything else bounces and sparks. */
  poke(): void {
    this.pokeT = POKE_MS;
  }

  update(tMs: number): void {
    const dt = Math.min(100, Math.max(0, tMs - this.lastT));
    this.lastT = tMs;
    this.drawPoke(dt);

    const target = this.active ? 1 : 0;
    if (REDUCE_MOTION) this.glow = target;
    else if (this.glow !== target) this.glow = Math.max(0, Math.min(1, this.glow + Math.sign(target - this.glow) * (dt / GLOW_MS)));
    // Ease-out both ways: lighting up lands softly, going dark drops away quickly and settles.
    const k = this.glow <= 0 ? 0 : this.active ? easeOut(this.glow) : 1 - easeOut(1 - this.glow);
    this.drawPlate(k);

    const g = this.ledOverlay;
    g.clear();
    const hl = this.highlight;
    hl.clear();
    // Idle stations stay completely still: nothing drawn, nothing moving.
    if (k <= 0) return;
    const c = this.accent;

    // Status LED in the station's colour, breathing slowly rather than strobing.
    for (let i = 0; i < this.def.leds.length; i++) {
      const led = this.def.leds[i];
      const breath = REDUCE_MOTION ? 1 : 0.75 + 0.25 * Math.sin(tMs / 520 + i * 1.9);
      g.rect(led.x - this.w / 2, led.y - this.h, 1, 1).fill({ color: c, alpha: k * breath });
    }

    if (this.def.counter) {
      // In use: this station's stretch of counter edge takes its colour and the
      // front panel is faintly washed with it. No floor glow, nothing moving.
      const span = SECTION_HALF * 2 - 6;
      hl.rect(-SECTION_HALF + 3, COUNTER_FRONT - 2 - this.def.bottom, span, 1).fill({ color: c, alpha: 0.85 * k });
      hl.rect(-SECTION_HALF + 3, COUNTER_FRONT + 2 - this.def.bottom, span, COUNTER_BOTTOM - COUNTER_FRONT - 5).fill({ color: c, alpha: 0.06 * k });
    } else if (this.def.onWall) {
      // Wall board in use: its marker-tray edge takes the accent, same language as the counter.
      hl.rect(-this.w / 2 + 1, -1, this.w - 2, 1).fill({ color: c, alpha: 0.85 * k });
    }
    // The war room shows its own in-session state (OfficeDecor), so nothing extra here.
  }

  /** Dark name plate (accent dot + hairline frame) behind the scene's station label text. */
  private drawPlate(k: number): void {
    const size = this.labelSize;
    if (!size) return;
    const s = this.container.parent?.scale.x || 1;
    const key = `${s}|${k.toFixed(2)}|${this.hovered}`;
    if (key === this.plateKey) return;
    this.plateKey = key;
    const g = this.plate;
    g.clear();
    const px = 1 / s;
    const half = Math.ceil(size.w / 2);
    const x0 = -(half + PLATE.padL) * px;
    const x1 = (half + PLATE.padR) * px;
    const y0 = 3 - PLATE.padY * px; // the label text is top-anchored 3 art px below the furniture
    const hPx = Math.round(size.h + PLATE.padY * 2);
    const hgt = hPx * px;
    const wdt = x1 - x0;
    g.rect(x0, y0, wdt, hgt).fill({ color: PLATE.fill, alpha: 0.86 });
    const rule = k > 0 ? mix(PLATE.rule, this.accent, 0.6 * k) : this.hovered ? PLATE.ruleHover : PLATE.rule;
    g.rect(x0, y0, wdt, px).fill(rule);
    g.rect(x0, y0 + hgt - px, wdt, px).fill(rule);
    g.rect(x0, y0, px, hgt).fill(rule);
    g.rect(x1 - px, y0, px, hgt).fill(rule);
    const dotY = y0 + Math.round((hPx - PLATE.dot) / 2) * px;
    g.rect(x0 + PLATE.dotX * px, dotY, PLATE.dot * px, PLATE.dot * px).fill({ color: this.accent, alpha: 0.55 + 0.45 * k });
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
      g.rect(left + 3, top + 2, 1, 4).fill(CASE_SHADE);
      const [x, y, flat] = fallPath(p, left + 3, top + 2, 2);
      if (flat) g.rect(x - 1, y + 2, 4, 1).fill(this.accent);
      else g.rect(x, y, 1, 4).fill(this.accent);
      if (p > 0.92) this.sparkle(g, left + 3, top + 3, (p - 0.92) / 0.08);
    } else if (this.def.key === "board") {
      // The second "doing" card peels off and flutters down, then gets pinned back.
      g.rect(left + 10, top + 7, 4, 2).fill(SCREEN);
      const [x, y] = fallPath(p, left + 10, top + 7, 3);
      g.rect(Math.round(x + Math.sin(p * 20) * 0.8), Math.round(y), 3, 2).fill(this.dim);
      if (p > 0.92) this.sparkle(g, left + 12, top + 7, (p - 0.92) / 0.08);
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

/** One continuous low counter along the back wall, one front panel per station. */
function drawCounter(defs: FurnitureDef[]): Graphics | null {
  const xs = defs.filter((d) => d.counter).map((d) => d.x).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const g = new Graphics();
  const x0 = xs[0] - SECTION_HALF;
  const x1 = xs[xs.length - 1] + 12;
  const w = x1 - x0;
  // Soft contact shadow on the floor.
  g.rect(x0, COUNTER_BOTTOM, w, 1).fill({ color: 0x050810, alpha: 0.55 });
  g.rect(x0 + 1, COUNTER_BOTTOM + 1, w - 2, 1).fill({ color: 0x050810, alpha: 0.25 });
  // Top surface, its lit front edge, then the lip throwing the front into shade.
  g.rect(x0, COUNTER_TOP, w, COUNTER_FRONT - COUNTER_TOP - 2).fill(COUNTER.top);
  g.rect(x0, COUNTER_FRONT - 2, w, 1).fill(COUNTER.edge);
  g.rect(x0, COUNTER_FRONT - 1, w, 1).fill(COUNTER.lip);
  g.rect(x0, COUNTER_FRONT, w, COUNTER_BOTTOM - COUNTER_FRONT).fill(COUNTER.face);
  g.rect(x0, COUNTER_BOTTOM - 2, w, 2).fill(COUNTER.toe);
  // Front panels, split by seams halfway between neighbouring stations.
  const bounds = [x0, ...xs.slice(1).map((x, i) => Math.round((x + xs[i]) / 2)), x1];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i] + 3;
    const b = bounds[i + 1] - 3;
    g.rect(a, COUNTER_FRONT + 2, b - a, 1).fill(COUNTER.panel);
    g.rect(a, COUNTER_FRONT + 2, 1, COUNTER_BOTTOM - COUNTER_FRONT - 5).fill(COUNTER.panel);
    if (i > 0) g.rect(bounds[i], COUNTER_FRONT, 1, COUNTER_BOTTOM - COUNTER_FRONT - 2).fill(COUNTER.seam);
  }
  // Behind every device sprite, in front of the wall and floor.
  g.zIndex = COUNTER_BOTTOM - 1;
  return g;
}

export class FurnitureLayer {
  readonly container = new Container();
  private readonly sprites = new Map<StationKey, FurnitureSprite>();

  constructor(
    private readonly onHover: (key: StationKey | null) => void = () => {},
    private readonly onSelect: (key: StationKey) => void = () => {},
  ) {
    this.container.sortableChildren = true;
    const counter = drawCounter(FURNITURE_DEFS);
    if (counter) this.container.addChild(counter);
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
