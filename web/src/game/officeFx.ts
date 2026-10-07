import { Container, Graphics } from "pixi.js";
import { drawZ } from "./person";

// Office-wide "something just happened between people" effects: paper planes
// carrying a dispatched task, the light link between collaborating NPCs, the
// one-shot summon beam, and sub-agent portals. Everything airborne is drawn
// into ONE Graphics that is cleared and redrawn per frame (like the particle
// system); portals stand on the floor and need depth-sorting with people, so
// each gets its own small pooled Graphics. Nothing here allocates per frame
// beyond a handful of points, and every list is capped.

export type Pt = { x: number; y: number };
type Resolver = () => Pt | null;

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const MAX_PLANES = 6;
const MAX_BEAMS = 6;
const MAX_PORTALS = 8;
const TRAIL_LEN = 16;

type Plane = {
  from: Pt;
  target: Resolver;
  last: Pt;
  t: number;
  ms: number;
  lift: number;
  trail: Pt[];
  onNear?: () => void;
  nearFired: boolean;
  onArrive: (at: Pt) => void;
};

type Beam = { a: Resolver; b: Resolver; t: number; ms: number; color: number };

/** 交棒：一根小棒沿低弧線從一人手上飛到另一人手上（協作交接／任務換手）。 */
type Baton = { from: Resolver; to: Resolver; last: Pt | null; t: number; ms: number; onArrive: () => void };
const MAX_BATONS = 4;

export type LinkSpec = {
  key: string;
  /** Packets travel from `from` to `to`. */
  from: Resolver;
  to: Resolver;
  color: number;
};
type Link = LinkSpec & { phase: number; seen: boolean; flashT: number };

type Portal = {
  x: number;
  y: number;
  g: Graphics;
  t: number;
  state: "opening" | "open" | "closing";
  closeAt: number;
};

export type PortalHandle = { close(): void; readonly x: number; readonly y: number };

/** Quadratic bezier with a raised control point — the plane's flight arc. */
function arc(a: Pt, b: Pt, lift: number, p: number): Pt {
  const cx = (a.x + b.x) / 2;
  const cy = Math.min(a.y, b.y) - lift;
  const q = 1 - p;
  return {
    x: q * q * a.x + 2 * q * p * cx + p * p * b.x,
    y: q * q * a.y + 2 * q * p * cy + p * p * b.y,
  };
}

const easeInOut = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);

export class OfficeFx {
  /** Airborne layer — above people. */
  readonly air = new Graphics();
  /** Parent for portal graphics; its children are re-parented into the world for z-sorting. */
  private readonly world: Container;
  private planes: Plane[] = [];
  private beams: Beam[] = [];
  private batons: Baton[] = [];
  private links = new Map<string, Link>();
  private portals: Portal[] = [];
  private pool: Graphics[] = [];
  private clock = 0;

  constructor(world: Container) {
    this.world = world;
    this.air.zIndex = 10_001;
  }

  /**
   * Launch a paper plane from `from` that homes in on a (possibly moving)
   * target. `onNear` fires once at ~80% of the flight (so the catcher can open
   * their arms), `onArrive` when it lands.
   */
  plane(from: Pt, target: Resolver, onArrive: (at: Pt) => void, onNear?: () => void): void {
    const to = target();
    if (!to) return;
    if (this.planes.length >= MAX_PLANES) this.planes.shift();
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    this.planes.push({
      from: { ...from },
      target,
      last: { ...to },
      t: 0,
      ms: REDUCE_MOTION ? 1 : Math.max(750, Math.min(1_600, dist * 4.2)),
      lift: Math.max(18, Math.min(60, dist * 0.32)),
      trail: [],
      onNear,
      nearFired: false,
      onArrive,
    });
  }

  /**
   * Hand a baton from one person to another (collaboration hand-off, mission
   * step changing hands). Both ends may move; `onArrive` fires when it lands
   * (immediately under reduced motion — the catch pose still plays).
   */
  baton(from: Resolver, to: Resolver, onArrive: () => void): void {
    const a = from();
    const b = to();
    if (!a || !b) return;
    if (REDUCE_MOTION) {
      onArrive();
      return;
    }
    if (this.batons.length >= MAX_BATONS) this.batons.shift();
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    this.batons.push({ from, to, last: null, t: 0, ms: Math.max(520, Math.min(1_100, dist * 3)), onArrive });
  }

  /** One-shot beam that shoots from a to b and fades (summoning a sub-agent). */
  beam(a: Resolver, b: Resolver, color = 0xb59cff, ms = 700): void {
    if (REDUCE_MOTION) return;
    if (this.beams.length >= MAX_BEAMS) this.beams.shift();
    this.beams.push({ a, b, t: 0, ms, color });
  }

  /** Persistent collaboration links; packets keep flowing while a link is listed. */
  setLinks(list: LinkSpec[]): void {
    for (const link of this.links.values()) link.seen = false;
    for (const spec of list) {
      const existing = this.links.get(spec.key);
      if (existing) {
        Object.assign(existing, spec, { seen: true });
      } else {
        // A brand-new link opens with a bright flash along its length.
        this.links.set(spec.key, { ...spec, phase: 0, seen: true, flashT: 700 });
      }
    }
    for (const [key, link] of this.links) if (!link.seen) this.links.delete(key);
  }

  /** A swirling floor portal at (x, y) — feet level. Close it with the handle. */
  openPortal(x: number, y: number, lifetimeMs = Infinity): PortalHandle {
    if (this.portals.length >= MAX_PORTALS) this.finishPortal(this.portals[0]);
    const g = this.pool.pop() ?? new Graphics();
    g.visible = true;
    g.position.set(Math.round(x), Math.round(y));
    g.zIndex = y - 0.5;
    this.world.addChild(g);
    const portal: Portal = { x, y, g, t: 0, state: "opening", closeAt: lifetimeMs };
    this.portals.push(portal);
    return {
      x,
      y,
      close: () => {
        if (portal.state !== "closing") {
          portal.state = "closing";
          portal.t = 0;
        }
      },
    };
  }

  update(dtMs: number): void {
    this.clock += dtMs;
    const g = this.air;
    g.clear();
    this.updateLinks(g, dtMs);
    this.updateBeams(g, dtMs);
    this.updatePlanes(g, dtMs);
    this.updateBatons(g, dtMs);
    this.updatePortals(dtMs);
  }

  private updateBatons(g: Graphics, dtMs: number): void {
    for (let i = this.batons.length - 1; i >= 0; i--) {
      const baton = this.batons[i];
      baton.t += dtMs;
      const a = baton.from();
      const b = baton.to() ?? baton.last;
      if (!a || !b) {
        this.batons.splice(i, 1);
        continue;
      }
      baton.last = b;
      const raw = Math.min(1, baton.t / baton.ms);
      if (raw >= 1) {
        this.batons.splice(i, 1);
        baton.onArrive();
        continue;
      }
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const pos = arc(a, b, Math.max(8, Math.min(24, dist * 0.2)), easeInOut(raw));
      // Tumbling end over end: horizontal, diagonal, upright, diagonal — whole pixels only.
      const spin = Math.floor(raw * 8) % 4;
      const x = Math.round(pos.x);
      const y = Math.round(pos.y);
      const cells: Array<[number, number]> = spin === 0 ? [[-2, 0], [-1, 0], [0, 0], [1, 0]]
        : spin === 1 ? [[-1, 1], [0, 0], [1, -1]]
        : spin === 2 ? [[0, -2], [0, -1], [0, 0], [0, 1]]
        : [[-1, -1], [0, 0], [1, 1]];
      cells.forEach(([dx, dy], k) => g.rect(x + dx, y + dy, 1, 1).fill(k === 0 ? 0xffffff : 0x4de3ff));
    }
  }

  private updatePlanes(g: Graphics, dtMs: number): void {
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const plane = this.planes[i];
      plane.t += dtMs;
      const to = plane.target() ?? plane.last;
      plane.last = to;
      const raw = Math.min(1, plane.t / plane.ms);
      const p = easeInOut(raw);
      const pos = arc(plane.from, to, plane.lift, p);
      // A gentle side-to-side wobble, damped out by the landing.
      const wob = Math.sin(raw * Math.PI * 5) * 1.4 * Math.sin(Math.PI * raw);
      pos.y += wob;
      if (!plane.nearFired && raw >= 0.8) {
        plane.nearFired = true;
        plane.onNear?.();
      }
      if (raw >= 1) {
        this.planes.splice(i, 1);
        plane.onArrive(to);
        continue;
      }
      plane.trail.push(pos);
      if (plane.trail.length > TRAIL_LEN) plane.trail.shift();
      // Faint dotted contrail: every other sample, fading toward the tail.
      for (let k = 0; k < plane.trail.length - 2; k += 2) {
        const dot = plane.trail[k];
        const a = (k / plane.trail.length) * 0.45;
        g.rect(Math.round(dot.x), Math.round(dot.y), 1, 1).fill({ color: 0xcfe3ff, alpha: a });
      }
      const ahead = arc(plane.from, to, plane.lift, easeInOut(Math.min(1, raw + 0.02)));
      this.drawPlane(g, pos, Math.atan2(ahead.y - pos.y, ahead.x - pos.x));
    }
  }

  /**
   * Folded-paper dart in profile: a long pale wing over a short darker keel,
   * the classic paper-plane silhouette. The wing tips up on whichever side is
   * "up" on screen so it never flies belly-up when heading left.
   */
  private drawPlane(g: Graphics, at: Pt, heading: number): void {
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const up = Math.abs(heading) > Math.PI / 2 ? 1 : -1;
    const P = (fx: number, fy: number): [number, number] => [
      Math.round((at.x + fx * cos - fy * up * sin) * 2) / 2,
      Math.round((at.y + fx * sin + fy * up * cos) * 2) / 2,
    ];
    const nose = P(5, 0);
    const wingTip = P(-4.5, 3.6);
    const notch = P(-2.4, 0.4);
    const keelTip = P(-3.6, -1.8);
    g.poly([...nose, ...wingTip, ...notch]).fill(0xeef4ff);
    g.poly([...nose, ...notch, ...keelTip]).fill(0x8ea6d4);
  }

  private updateBeams(g: Graphics, dtMs: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i];
      beam.t += dtMs;
      const a = beam.a();
      const b = beam.b();
      const p = beam.t / beam.ms;
      if (p >= 1 || !a || !b) {
        this.beams.splice(i, 1);
        continue;
      }
      // Shoots out over the first 30%, then fades in place.
      const reach = Math.min(1, p / 0.3);
      const fade = p < 0.3 ? 1 : 1 - (p - 0.3) / 0.7;
      this.dotted(g, a, b, reach, 2, beam.color, 0.85 * fade, 0);
      const tip = arc(a, b, Math.hypot(b.x - a.x, b.y - a.y) * 0.18, reach);
      g.rect(Math.round(tip.x) - 1, Math.round(tip.y) - 1, 2, 2).fill({ color: 0xffffff, alpha: fade });
    }
  }

  private updateLinks(g: Graphics, dtMs: number): void {
    for (const link of this.links.values()) {
      const a = link.from();
      const b = link.to();
      if (!a || !b) continue;
      const lift = Math.hypot(b.x - a.x, b.y - a.y) * 0.18;
      if (link.flashT > 0) link.flashT -= dtMs;
      const flash = Math.max(0, link.flashT / 700);
      // Faint standing beam — the two are connected — with a slow shimmer.
      const shimmer = REDUCE_MOTION ? 0 : this.clock / 120;
      this.dotted(g, a, b, 1, 3, link.color, 0.22 + 0.5 * flash, 0, shimmer);
      if (REDUCE_MOTION) continue;
      // A packet of work every 2.4s: travels the arc with a short tail, and
      // the receiving end blinks when it lands.
      link.phase += dtMs;
      const cycle = 2_400;
      const p = (link.phase % cycle) / 1_500;
      if (p <= 1) {
        const e = easeInOut(p);
        for (let k = 0; k < 4; k++) {
          const q = Math.max(0, e - k * 0.035);
          const pt = arc(a, b, lift, q);
          const size = k === 0 ? 2 : 1;
          g.rect(Math.round(pt.x) - size / 2, Math.round(pt.y) - size / 2, size, size)
            .fill({ color: k === 0 ? 0xffffff : link.color, alpha: k === 0 ? 1 : 0.7 - k * 0.15 });
        }
      } else if (p < 1.25) {
        const r = 2 + (p - 1) * 14;
        g.circle(b.x, b.y, r).stroke({ color: link.color, width: 0.7, alpha: 0.7 * (1 - (p - 1) / 0.25) });
      }
    }
  }

  /** Dotted arc a→b, drawn up to `reach` (0..1). `step` is the dot spacing in px. */
  private dotted(g: Graphics, a: Pt, b: Pt, reach: number, step: number, color: number, alpha: number, liftOverride: number, offset = 0): void {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < 2) return;
    const lift = liftOverride || dist * 0.18;
    const n = Math.max(2, Math.floor((dist * 1.1) / step));
    const start = offset % 1;
    for (let i = 0; i < n; i++) {
      const p = (i + start) / n;
      if (p > reach) break;
      const pt = arc(a, b, lift, p);
      g.rect(Math.round(pt.x), Math.round(pt.y), 1, 1).fill({ color, alpha });
    }
  }

  private updatePortals(dtMs: number): void {
    for (let i = this.portals.length - 1; i >= 0; i--) {
      const portal = this.portals[i];
      portal.t += dtMs;
      if (portal.state === "opening" && portal.t >= 260) {
        portal.state = "open";
        portal.t = 0;
      } else if (portal.state === "open" && portal.t >= portal.closeAt) {
        portal.state = "closing";
        portal.t = 0;
      } else if (portal.state === "closing" && portal.t >= 280) {
        this.finishPortal(portal);
        continue;
      }
      const open = portal.state === "opening" ? portal.t / 260
        : portal.state === "closing" ? 1 - portal.t / 280
        : 1;
      this.drawPortal(portal.g, Math.max(0, Math.min(1, open)));
    }
  }

  /** Upright oval doorway of swirling violet/cyan pixels, with a glow puddle on the floor. */
  private drawPortal(g: Graphics, open: number): void {
    g.clear();
    if (open <= 0) return;
    const rx = 5.5 * (REDUCE_MOTION ? 1 : Math.min(1, open * 1.2));
    const ry = 9.5 * open;
    const cy = -ry;
    g.ellipse(0, 0, 8 * open, 2.4 * open).fill({ color: 0x9b7bff, alpha: 0.18 });
    g.ellipse(0, cy, rx, ry).fill({ color: 0x150f33, alpha: 0.88 });
    g.ellipse(0, cy, rx, ry).stroke({ color: 0x9b7bff, width: 1, alpha: 0.95 });
    g.ellipse(0, cy, rx * 0.62, ry * 0.7).stroke({ color: 0x4de3ff, width: 0.6, alpha: 0.55 });
    // Orbiting sparks give the swirl; frozen when motion is reduced.
    const spin = REDUCE_MOTION ? 0 : this.clock / 260;
    for (let k = 0; k < 6; k++) {
      const a = spin + (k / 6) * Math.PI * 2;
      const r = k % 2 === 0 ? 1 : 0.55;
      g.rect(Math.round(Math.cos(a) * rx * r), Math.round(cy + Math.sin(a) * ry * r), 1, 1)
        .fill({ color: k % 2 === 0 ? 0xe6dcff : 0x9ff3ff, alpha: 0.9 * open });
    }
  }

  private finishPortal(portal: Portal): void {
    const index = this.portals.indexOf(portal);
    if (index >= 0) this.portals.splice(index, 1);
    portal.g.clear();
    portal.g.visible = false;
    portal.g.removeFromParent();
    this.pool.push(portal.g);
  }

  destroy(): void {
    this.batons = [];
    for (const portal of [...this.portals]) this.finishPortal(portal);
    for (const g of this.pool) g.destroy();
    this.pool = [];
    this.air.destroy();
  }
}

// ───────────────────────── Power cut / reboot ─────────────────────────
// While the link to the local server is down the office is a dark office at
// night: deep blue shade over everything, moonlight falling in through the
// window, amber standby LEDs on the monitors, the crew dozing ("z z" drawn
// here, above the shade, so they stay readable) and a small "reconnecting"
// sign on the wall. When the link comes back, the lights come on lamp by lamp —
// each zone (station row, every department, the meeting table) stutters like
// a fluorescent tube, clunks a touch too bright and settles. A zone's monitors
// boot once it is lit, and the owner wakes the NPCs standing under it (lit()).
//
// The light map is drawn as 4px cells with run-merging, so falloff is soft
// but stays pixel-art, and nothing has a hard straight edge. It is only
// rebuilt while something changes (the fade-in, the boot), not every frame.

export type Rect = { x: number; y: number; w: number; h: number };
/** A ceiling light over a zone: centre and radii of its pool of light. */
export type Lamp = { x: number; y: number; rx: number; ry: number };

const NIGHT = 0x030716;
const DARK = 0.74;
const CELL = 4;
const LEVELS = 20;
/** One lamp: stutter, clunk past full, settle. */
const LAMP_MS = 720;
/** After the last lamp, whatever no lamp covers fades up too. */
const AMBIENT_MS = 450;
const BOOT_MS = 950;

/** Brightness of a fluorescent tube `s` ms after its switch is thrown (0..~1.25). */
function tubeLevel(s: number): number {
  if (s <= 0) return 0;
  if (REDUCE_MOTION) return Math.min(1, s / 400);
  if (s < 50) return 0.5;      // first strike
  if (s < 120) return 0.06;    // drops out
  if (s < 165) return 0.75;    // catches…
  if (s < 250) return 0.18;    // …stutters once more
  if (s < 300) return 0.18 + (s - 250) / 50 * 1.07; // clunk — on, a touch too bright
  if (s < LAMP_MS) return 1 + 0.25 * (1 - easeOut((s - 300) / (LAMP_MS - 300)));
  return 1;
}

function easeOut(p: number): number {
  return 1 - (1 - p) * (1 - p);
}

export class OfficePower {
  /** Shade + effects; sits above people and furniture, below the airborne fx. */
  readonly view = new Container();
  private readonly shade = new Graphics();
  private readonly g = new Graphics();
  /** Ceiling lights, one per zone — kept current by the owner. */
  lamps: Lamp[] = [];
  /** Desk monitors (world rects of the screen glass) — kept current by the owner. */
  monitors: Rect[] = [];
  /** Heads of everyone currently asleep — kept current by the owner. */
  sleepers: Pt[] = [];
  private state: "on" | "down" | "booting" = "on";
  private t = 0;
  private clock = 0;
  /** Switch-on time of each lamp (ms into the boot), in the order they come on. */
  private starts: number[] = [];
  private lampsAtBoot: Lamp[] = [];
  private ambientAt = 0;
  private shadeDirty = true;

  constructor(private area: Rect, private readonly sign: Pt, private readonly window: Rect | null = null) {
    this.view.zIndex = 9_500;
    this.view.eventMode = "none";
    this.view.addChild(this.shade, this.g);
  }

  /** The floor grew or shrank (annex for big crews). */
  setArea(area: Rect): void {
    this.area = area;
    this.shadeDirty = true;
  }

  /** Lights are out (or still coming back somewhere). */
  get dark(): boolean {
    return this.state !== "on";
  }

  get isDown(): boolean {
    return this.state === "down";
  }

  setDown(): void {
    if (this.state === "down") return;
    this.state = "down";
    this.t = 0;
    this.shadeDirty = true;
  }

  setUp(): void {
    if (this.state !== "down") return;
    this.state = "booting";
    this.t = 0;
    // Room by room: the order the owner listed them in, with an organic,
    // slightly uneven rhythm, squeezed so the whole thing stays ~3 s.
    this.lampsAtBoot = [...this.lamps];
    const n = this.lampsAtBoot.length;
    const gap = n > 1 ? Math.min(420, 1_900 / (n - 1)) : 0;
    let at = 220;
    this.starts = this.lampsAtBoot.map((_, i) => {
      const start = at;
      at += gap * (0.75 + Math.random() * 0.5) * (i % 3 === 2 ? 1.25 : 1);
      return start;
    });
    this.ambientAt = (n ? Math.max(...this.starts) : 0) + LAMP_MS * 0.6;
    this.shadeDirty = true;
  }

  /** Is the light over (x, y) back on? NPCs standing there may wake. */
  lit(x: number, y: number): boolean {
    if (this.state === "on") return true;
    if (this.state === "down") return false;
    const i = this.lampFor(x, y);
    return this.t >= (i < 0 ? this.ambientAt + 150 : this.starts[i] + 320);
  }

  /** Index of the lamp lighting (x, y) the most during this boot, or -1. */
  private lampFor(x: number, y: number): number {
    let best = -1;
    let bestF = 0.25;
    this.lampsAtBoot.forEach((lamp, i) => {
      const f = falloff(lamp, x, y);
      if (f > bestF) {
        bestF = f;
        best = i;
      }
    });
    return best;
  }

  update(dtMs: number): void {
    this.clock += dtMs;
    this.t += dtMs;
    const g = this.g;
    g.clear();
    if (this.state === "on") {
      if (this.shadeDirty) {
        this.shade.clear();
        this.shadeDirty = false;
      }
      return;
    }
    const down = this.state === "down";
    // The shade only changes while fading out or while the lamps come on.
    if (this.shadeDirty || (down && this.t < 700) || !down) this.drawShade();
    if (down && this.t >= 700) this.shadeDirty = false;

    for (const m of this.monitors) {
      if (down) {
        this.standby(g, m, Math.min(1, this.t / 500));
        continue;
      }
      const i = this.lampFor(m.x + m.w / 2, m.y + m.h / 2);
      const s = this.t - (i < 0 ? this.ambientAt + AMBIENT_MS : this.starts[i] + LAMP_MS * 0.55);
      if (s < 0) this.standby(g, m, 1);
      else if (s < BOOT_MS) this.booting(g, m, s);
    }
    for (const p of this.sleepers) {
      for (let k = 0; k < 2; k++) {
        const q = REDUCE_MOTION ? 0.35 + k * 0.3 : ((this.clock / 1_700 + k * 0.5 + p.x * 0.013) % 1);
        drawZ(g, p.x + 4 + q * 4 + k, p.y - 2 - q * 9, k === 0 ? 3 : 4, 1 - q * 0.75);
      }
    }
    this.drawSign(g);
    if (!down && this.t > this.ambientAt + AMBIENT_MS + BOOT_MS) {
      this.state = "on";
      this.shadeDirty = true;
    }
  }

  /** Darkness (0..1 alpha) left at (x, y) right now; warm overshoot in `warm`. */
  private shadeAt(x: number, y: number, fadeIn: number, out: { warm: number }): number {
    let dark = DARK * fadeIn;
    out.warm = 0;
    // Moonlight: the window glows and a slanted pool of light falls across the floor below it.
    const moon = this.moonAt(x, y);
    dark *= 1 - 0.5 * moon;
    if (this.state === "booting") {
      for (let i = 0; i < this.lampsAtBoot.length; i++) {
        const f = falloff(this.lampsAtBoot[i], x, y);
        if (f <= 0) continue;
        const level = tubeLevel(this.t - this.starts[i]);
        dark *= 1 - Math.min(1, level) * f;
        if (level > 1) out.warm = Math.max(out.warm, (level - 1) * f);
      }
      const ambient = Math.max(0, Math.min(1, (this.t - this.ambientAt) / AMBIENT_MS));
      dark *= 1 - ambient;
    }
    return dark;
  }

  private moonAt(x: number, y: number): number {
    const w = this.window;
    if (!w) return 0;
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return 0.8;
    const floorTop = w.y + w.h + 6;
    if (y < floorTop) return 0;
    const depth = y - floorTop;
    if (depth > 120) return 0;
    // Slants down-left, like moonlight through a high window.
    const shift = depth * 0.55;
    const left = w.x + 4 - shift;
    const right = w.x + w.w - 4 - shift;
    if (x < left - 6 || x > right + 6) return 0;
    const edge = Math.min(1, Math.min(x - (left - 6), right + 6 - x) / 10);
    return 0.55 * edge * (1 - depth / 120);
  }

  /** Rebuild the light map: one rect per run of equal (quantised) darkness. */
  private drawShade(): void {
    const s = this.shade;
    s.clear();
    const { x: ax, y: ay, w, h } = this.area;
    const fadeIn = this.state === "down" ? Math.min(1, this.t / 650) : 1;
    // Lights sputter out over the first half-second.
    const sputter = this.state === "down" && !REDUCE_MOTION && this.t < 520 && this.t % 160 < 50 ? 0.2 : 1;
    const warmOut = { warm: 0 };
    const cols = Math.ceil(w / CELL);
    const rows = Math.ceil(h / CELL);
    for (let r = 0; r < rows; r++) {
      const cy = ay + r * CELL + CELL / 2;
      let runStart = 0;
      let runLevel = -1;
      let warmStart = 0;
      let warmLevel = 0;
      const flush = (end: number) => {
        if (runLevel > 0) s.rect(ax + runStart * CELL, ay + r * CELL, (end - runStart) * CELL, CELL).fill({ color: NIGHT, alpha: runLevel / LEVELS });
      };
      const flushWarm = (end: number) => {
        if (warmLevel > 0) s.rect(ax + warmStart * CELL, ay + r * CELL, (end - warmStart) * CELL, CELL).fill({ color: 0xffe2a8, alpha: warmLevel * 0.025 });
      };
      for (let c = 0; c <= cols; c++) {
        let level = 0;
        let warm = 0;
        if (c < cols) {
          const dark = this.shadeAt(ax + c * CELL + CELL / 2, cy, fadeIn * sputter, warmOut);
          level = Math.round(dark * LEVELS);
          warm = Math.round(warmOut.warm * 6);
        }
        if (level !== runLevel) {
          flush(c);
          runStart = c;
          runLevel = level;
        }
        if (warm !== warmLevel) {
          flushWarm(c);
          warmStart = c;
          warmLevel = warm;
        }
      }
    }
    // A faint cool tint inside the moonbeam so it reads as moonlight, not just "less dark".
    if (this.window && this.state === "down") {
      const wdw = this.window;
      const top = wdw.y + wdw.h + 6;
      for (let d = 0; d < 110; d += CELL * 2) {
        const shift = d * 0.55;
        s.rect(wdw.x + 6 - shift, top + d, wdw.w - 12, CELL * 2).fill({ color: 0x9fc4ff, alpha: 0.045 * (1 - d / 110) * fadeIn });
      }
    }
  }

  private standby(g: Graphics, m: Rect, k: number): void {
    g.rect(m.x, m.y, m.w, m.h).fill({ color: 0x05070d, alpha: 0.92 * k });
    // Amber standby LED, breathing slowly, with a faint glow around it.
    const breathe = REDUCE_MOTION ? 0.8 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin((this.clock + m.x * 37) / 600));
    const lx = m.x + m.w - 2;
    const ly = m.y + m.h - 2;
    g.rect(lx - 1, ly - 1, 3, 3).fill({ color: 0xffb547, alpha: 0.12 * breathe * k });
    g.rect(lx, ly, 1, 1).fill({ color: 0xffc66b, alpha: breathe * k });
  }

  /** Boot: black screen, then a small logo and a filling boot bar; then the real content shows through. */
  private booting(g: Graphics, m: Rect, s: number): void {
    const fadeOut = s > BOOT_MS - 150 ? (BOOT_MS - s) / 150 : 1;
    g.rect(m.x, m.y, m.w, m.h).fill({ color: 0x05070d, alpha: 0.95 * fadeOut });
    if (s < 300) return;
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2 - 1;
    const blink = REDUCE_MOTION || Math.floor(s / 160) % 2 === 0;
    g.rect(cx - 1, cy - 1, 2, 2).fill({ color: 0x4de3ff, alpha: (blink ? 0.95 : 0.6) * fadeOut });
    g.rect(cx - 0.5, cy - 1.5, 1, 1).fill({ color: 0xffffff, alpha: 0.7 * fadeOut });
    const p = Math.min(1, (s - 300) / (BOOT_MS - 450));
    g.rect(m.x + 2, m.y + m.h - 1.6, m.w - 4, 0.8).fill({ color: 0x1a2a44, alpha: fadeOut });
    g.rect(m.x + 2, m.y + m.h - 1.6, (m.w - 4) * p, 0.8).fill({ color: 0x4de3ff, alpha: fadeOut });
  }

  /** Wall sign: an unplugged cable wiggling by its socket, sparks, a spinner. Plugged back in on reconnect. */
  private drawSign(g: Graphics): void {
    const { x, y } = this.sign;
    const down = this.state === "down";
    if (!down && this.t > 650) return;
    const fade = down ? Math.min(1, this.t / 400) : 1 - this.t / 650;
    const accent = down ? 0xffb547 : 0x37d6a3;
    g.roundRect(x - 13, y - 5, 26, 10, 3).fill({ color: 0x0b1226, alpha: 0.9 * fade })
      .stroke({ color: accent, width: 0.8, alpha: 0.75 * fade });
    const gap = down ? 3 + (REDUCE_MOTION ? 0 : Math.sin(this.clock / 300)) : 0;
    g.rect(x - 11, y - 0.5, 2, 1).fill({ color: 0x8fa3c8, alpha: fade });
    g.rect(x - 9, y - 2, 3, 4).fill({ color: accent, alpha: fade });
    g.rect(x - 6, y - 1.5, 1.5, 0.8).fill({ color: 0xdfe9f8, alpha: fade });
    g.rect(x - 6, y + 0.7, 1.5, 0.8).fill({ color: 0xdfe9f8, alpha: fade });
    g.rect(x - 4.5 + gap, y - 2.5, 2, 5).fill({ color: 0x3b4a6b, alpha: fade });
    g.rect(x - 2.5 + gap, y - 0.5, 2, 1).fill({ color: 0x8fa3c8, alpha: fade });
    if (down && !REDUCE_MOTION && Math.floor(this.clock / 120) % 4 === 0) {
      g.rect(x - 4.5, y - 3.5, 1, 1).fill(0xfff3c4);
      g.rect(x - 3.5, y + 2.5, 1, 1).fill(0xfff3c4);
    }
    if (!down) return;
    const sx = x + 7;
    const head = REDUCE_MOTION ? 0 : Math.floor(this.clock / 110) % 8;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const age = (head - k + 8) % 8;
      g.rect(Math.round(sx + Math.cos(a) * 2.6) - 0.5, Math.round(y + Math.sin(a) * 2.6) - 0.5, 1, 1)
        .fill({ color: accent, alpha: fade * Math.max(0.15, 1 - age * 0.18) });
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

/** 0..1 how much a lamp lights (x, y): a bright plateau with a soft edge. */
function falloff(lamp: Lamp, x: number, y: number): number {
  const dx = (x - lamp.x) / lamp.rx;
  const dy = (y - lamp.y) / lamp.ry;
  const d2 = dx * dx + dy * dy;
  if (d2 >= 1) return 0;
  const f = Math.min(1, (1 - d2) * 1.8);
  return f * f * (3 - 2 * f);
}

// ───────────────────────── System cues ─────────────────────────
// Short (<2s) echoes of a settings change, popped above the office:
// a phone with signal waves (remote control on/off), a ringing bell
// (desktop notifications on) or a spinning gear with a tick (settings saved).

export type SystemCueKind = "remote-on" | "remote-off" | "notify-on" | "settings-saved";
export const SYSTEM_CUE_MS = 1_900;

export class SystemCues {
  readonly g = new Graphics();
  private kind: SystemCueKind | null = null;
  private t = 0;
  private at: Pt = { x: 0, y: 0 };

  constructor() {
    this.g.zIndex = 10_003;
    this.g.eventMode = "none";
  }

  play(kind: SystemCueKind, at: Pt): void {
    this.kind = kind;
    this.t = 0;
    this.at = { x: Math.round(at.x), y: Math.round(at.y) };
  }

  get active(): boolean {
    return this.kind !== null;
  }

  update(dtMs: number): void {
    const g = this.g;
    g.clear();
    if (!this.kind) return;
    this.t += dtMs;
    if (this.t >= SYSTEM_CUE_MS) {
      this.kind = null;
      return;
    }
    const t = this.t;
    // Pop in with a little overshoot, fade out at the end.
    const s = REDUCE_MOTION ? 1 : t < 220 ? backOut(t / 220) : 1;
    const alpha = t > SYSTEM_CUE_MS - 350 ? (SYSTEM_CUE_MS - t) / 350 : 1;
    const { x, y } = this.at;
    const accent = this.kind === "remote-off" ? 0xff5d73
      : this.kind === "notify-on" ? 0xffd166
      : this.kind === "settings-saved" ? 0x9fb6cf
      : 0x4de3ff;
    g.circle(x, y, 13 * s).fill({ color: accent, alpha: 0.12 * alpha });
    g.circle(x, y, 9 * s).fill({ color: 0x0b1226, alpha: 0.85 * alpha });
    const R = (rx: number, ry: number, w: number, h: number, color: number) =>
      g.rect(x + rx * s, y + ry * s, w * s, h * s).fill({ color, alpha });
    if (this.kind === "remote-on" || this.kind === "remote-off") {
      const on = this.kind === "remote-on";
      R(-3.5, -6.5, 7, 13, 0x1a2238);
      R(-3.5, -6.5, 7, 1, 0x3b4a6b);
      R(-2.5, -5, 5, 9, on ? 0x4de3ff : 0x2a3550);
      if (on) {
        R(-1.5, -3.5, 3, 1, 0xdfe9f8);
        R(-1.5, -1.5, 2, 1, 0xdfe9f8);
      }
      R(-0.5, 4.8, 1, 1, 0x6f7fa3);
      // Signal waves: rippling outward (on) or collapsing inward (off).
      const flow = REDUCE_MOTION ? 0.5 : (t % 700) / 700;
      for (let k = 0; k < 3; k++) {
        const r = on ? 7 + k * 3 + flow * 3 : 14 - k * 3 - flow * 3;
        const a = alpha * (on ? 1 - k * 0.25 : 0.4 + k * 0.2);
        for (const side of [0, Math.PI]) {
          g.moveTo(x + Math.cos(side - 0.55) * r, y + Math.sin(side - 0.55) * r);
          g.arc(x, y, r, side - 0.55, side + 0.55).stroke({ color: accent, width: 1, alpha: a });
        }
      }
      if (!on) g.moveTo(x - 7 * s, y - 8 * s).lineTo(x + 7 * s, y + 8 * s).stroke({ color: 0xff5d73, width: 1.6, alpha });
    } else if (this.kind === "notify-on") {
      // A bell swinging on its hook, ringing out, with a red badge.
      const swing = REDUCE_MOTION ? 0 : Math.sin(t / 85) * 0.55 * Math.max(0, 1 - t / 1_500);
      const cos = Math.cos(swing);
      const sin = Math.sin(swing);
      const P = (px: number, py: number): [number, number] => {
        const ry = py + 7;
        return [x + (px * cos - ry * sin) * s, y - 7 * s + (px * sin + ry * cos) * s];
      };
      g.poly([...P(-1.5, -6), ...P(1.5, -6), ...P(3, -4), ...P(3.6, 1), ...P(5, 3), ...P(-5, 3), ...P(-3.6, 1), ...P(-3, -4)])
        .fill({ color: 0xffd166, alpha });
      g.poly([...P(-5.5, 3), ...P(5.5, 3), ...P(5.5, 4.4), ...P(-5.5, 4.4)]).fill({ color: 0xc29a3a, alpha });
      g.poly([...P(-2.2, -4), ...P(-1.2, -4), ...P(-1.8, 1), ...P(-2.8, 1)]).fill({ color: 0xfff3c4, alpha: alpha * 0.8 });
      const [kx, ky] = P(-swing * 4, 5.6);
      g.circle(kx, ky, 1.3 * s).fill({ color: 0xc29a3a, alpha });
      const [hx, hy] = P(0, -7);
      g.circle(hx, hy, 1 * s).fill({ color: 0xffd166, alpha });
      if (!REDUCE_MOTION && Math.floor(t / 180) % 2 === 0 && t < 1_500) {
        for (const side of [0, Math.PI]) {
          for (const r of [9, 11.5]) {
            g.moveTo(x + Math.cos(side - 0.45) * r, y + Math.sin(side - 0.45) * r);
            g.arc(x, y, r, side - 0.45, side + 0.45).stroke({ color: 0xffd166, width: 1, alpha: alpha * 0.8 });
          }
        }
      }
      g.circle(x + 5 * s, y - 6 * s, 2 * s).fill({ color: 0xff5d73, alpha });
    } else {
      // Gear spinning down, sparkles, then a green tick badge pops in.
      const spin = REDUCE_MOTION ? 0 : 7 * (1 - Math.exp(-t / 450));
      for (let k = 0; k < 8; k++) {
        const a = spin + (k * Math.PI) / 4;
        const cx = x + Math.cos(a) * 5 * s;
        const cy = y + Math.sin(a) * 5 * s;
        const c = Math.cos(a) * 1.3 * s;
        const d = Math.sin(a) * 1.3 * s;
        g.poly([cx - c + d, cy - d - c, cx + c + d, cy + d - c, cx + c - d, cy + d + c, cx - c - d, cy - d + c])
          .fill({ color: 0x9fb6cf, alpha });
      }
      g.circle(x, y, 4.3 * s).fill({ color: 0x9fb6cf, alpha });
      g.circle(x, y, 4.3 * s).stroke({ color: 0xdfe9f8, width: 0.7, alpha });
      g.circle(x, y, 1.7 * s).fill({ color: 0x0b1226, alpha });
      if (t > 600) {
        const q = Math.min(1, (t - 600) / 700);
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
          const r = 8 + q * 6;
          const px = Math.round(x + Math.cos(a) * r);
          const py = Math.round(y + Math.sin(a) * r);
          g.rect(px - 1, py, 3, 1).fill({ color: 0xfff3c4, alpha: alpha * (1 - q) });
          g.rect(px, py - 1, 1, 3).fill({ color: 0xfff3c4, alpha: alpha * (1 - q) });
        }
        const b = REDUCE_MOTION ? 1 : backOut(Math.min(1, (t - 600) / 200));
        g.circle(x + 6, y + 5, 3.2 * b).fill({ color: 0x37d6a3, alpha });
        for (const [cx, cy] of [[-1.5, 0], [-0.5, 1], [0.5, 0], [1.5, -1]] as Array<[number, number]>) {
          g.rect(x + 6 + cx * b - 0.5, y + 5 + cy * b - 0.5, 1, 1).fill({ color: 0xffffff, alpha });
        }
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}

/** Ease-out with a small overshoot (0 → ~1.1 → 1). */
function backOut(p: number): number {
  const c = 1.7;
  const q = p - 1;
  return 1 + (c + 1) * q * q * q + c * q * q;
}

// ───────────────────────── Dance party (Konami code) ─────────────────────────
// A disco ball drops from the ceiling, the room dims a little, coloured spots
// sweep the floor and sparkles skitter over the walls. ~8 s, then it all
// winds back up. The owner makes the crew dance (see scene).

const PARTY_COLORS = [0xff4dd8, 0x4de3ff, 0xffd166, 0x37d6a3, 0x9b7bff, 0xf29e4c];

export class DiscoParty {
  readonly view = new Container();
  private readonly dimG = new Graphics();
  private readonly lightG = new Graphics();
  private readonly ballG = new Graphics();
  private t = 0;
  private ms = 0;

  constructor(private area: Rect, private readonly hang: Pt) {
    this.view.zIndex = 9_450;
    this.view.eventMode = "none";
    this.lightG.blendMode = "add";
    this.view.addChild(this.dimG, this.lightG, this.ballG);
  }

  get active(): boolean {
    return this.t < this.ms;
  }

  setArea(area: Rect): void {
    this.area = area;
  }

  start(ms = 8_000): void {
    this.t = 0;
    this.ms = ms;
  }

  update(dtMs: number): void {
    this.dimG.clear();
    this.lightG.clear();
    this.ballG.clear();
    if (!this.active) return;
    this.t += dtMs;
    const t = this.t;
    // Fade in / out at the ends; the ball drops down and later goes back up.
    const k = Math.min(1, t / 500, (this.ms - t) / 700);
    if (k <= 0) return;
    const { x, y, w, h } = this.area;
    this.dimG.rect(x, y, w, h).fill({ color: 0x050816, alpha: 0.35 * k });
    const bx = this.hang.x;
    const by = this.hang.y + 14 * Math.min(1, t / 600, (this.ms - t) / 600);
    const spin = REDUCE_MOTION ? 0 : t / 120;
    // Spots sweeping the floor, with faint beams back to the ball.
    for (let i = 0; i < 6; i++) {
      const color = PARTY_COLORS[(i + Math.floor(t / 900)) % PARTY_COLORS.length];
      const sx = x + w / 2 + Math.sin(t / (1_400 + i * 170) + i * 1.9) * (w * 0.4);
      const sy = y + h * 0.62 + Math.cos(t / (1_100 + i * 230) + i * 2.6) * (h * 0.28);
      this.lightG.poly([bx - 1, by + 4, bx + 1, by + 4, sx + 9, sy, sx - 9, sy]).fill({ color, alpha: 0.05 * k });
      this.lightG.ellipse(sx, sy, 16, 6.5).fill({ color, alpha: 0.12 * k });
      this.lightG.ellipse(sx, sy, 10, 4).fill({ color, alpha: 0.16 * k });
    }
    // Glints skittering over walls and floor.
    const bucket = Math.floor(t / 160);
    for (let i = 0; i < 14; i++) {
      const px = x + hash(bucket * 31 + i) * w;
      const py = y + hash(bucket * 17 + i * 7) * h;
      this.lightG.rect(Math.round(px), Math.round(py), 1, 1).fill({ color: 0xffffff, alpha: 0.7 * k });
    }
    // The ball: string, mirrored facets shifting as it turns.
    this.ballG.rect(bx - 0.5, this.hang.y, 1, by - this.hang.y - 4).fill({ color: 0x8fa3c8, alpha: k });
    this.ballG.circle(bx, by, 5).fill({ color: 0x9aa6bd, alpha: k });
    for (let r = -4; r <= 3; r += 2) {
      for (let c = -4; c <= 3; c += 2) {
        if (r * r + c * c > 20) continue;
        const lit = (Math.floor(spin) + r + c + 40) % 3 === 0;
        this.ballG.rect(bx + c, by + r, 1.6, 1.6).fill({ color: lit ? 0xffffff : 0xc9d4ea, alpha: k });
      }
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

function hash(n: number): number {
  const v = Math.sin(n * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}
