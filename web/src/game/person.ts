import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { CharacterActivity } from "../types";
import { PAL, texFromMap } from "./pixels";

// ---------- Front (facing camera) ----------

const FRONT_IDLE_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBbBBBBbBS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const FRONT_IDLE_1 = [
  "............",
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBbBBBBbBS.",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const FRONT_WALK_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBS..",
  "..PPPPPPPP..",
  ".PPP....ppp.",
  ".PPP....ppp.",
  ".FFF....FFF.",
  "............",
];

const FRONT_WALK_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  "..BBBBBBBBS.",
  ".SBbBBBBbBS.",
  ".SBBBBBBBB..",
  "..PPPPPPPP..",
  ".ppp....PPP.",
  ".ppp....PPP.",
  ".FFF....FFF.",
  "............",
];

// ---------- Side (profile, drawn facing right; flip for left) ----------

const SIDE_STRIDE_A = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHSSSSSS..",
  "..HHSSSSES..",
  "..HHSSSSSS..",
  "....SSSS....",
  "....BBBB....",
  "..SBBBBBB...",
  "...BBBBBBS..",
  "....BBBB....",
  "....PPPP....",
  "...pp..PP...",
  "..pp....PP..",
  "..FF....FF..",
  "............",
];

const SIDE_PASS = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHSSSSSS..",
  "..HHSSSSES..",
  "..HHSSSSSS..",
  "....SSSS....",
  "....BBBB....",
  "...BBBBBB...",
  "...SBBBBS...",
  "....BBBB....",
  "....PPPP....",
  "....PPpp....",
  "....PPpp....",
  "....FFFF....",
  "............",
];

const SIDE_STRIDE_B = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHSSSSSS..",
  "..HHSSSSES..",
  "..HHSSSSSS..",
  "....SSSS....",
  "....BBBB....",
  "...BBBBBBS..",
  "..SBBBBBB...",
  "....BBBB....",
  "....PPPP....",
  "...PP..pp...",
  "..PP....pp..",
  "..FF....FF..",
  "............",
];

// ---------- Back (facing away, working / walking away) ----------

const BACK_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBbBBBBbBS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const BACK_TYPE_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  ".SBBBBBBBBS.",
  ".SBBBBBBBBS.",
  "..BbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

const BACK_WALK_0 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  "..BBBBBBBB..",
  ".SBBBBBBBB..",
  ".SBbBBBBbB..",
  "..BBBBBBBS..",
  "..PPPPPPPP..",
  ".PPP....ppp.",
  ".PPP....ppp.",
  ".FFF....FFF.",
  "............",
];

const BACK_WALK_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HHHHHHHH..",
  "..HhHHHHhH..",
  "..HHHHHHHH..",
  "...hHHHHh...",
  "..BBBBBBBB..",
  "..BBBBBBBBS.",
  ".SBbBBBBbBS.",
  ".SBBBBBBBB..",
  "..PPPPPPPP..",
  ".ppp....PPP.",
  ".ppp....PPP.",
  ".FFF....FFF.",
  "............",
];

const CHEER = [
  ".S..HHHH..S.",
  ".S.HHHHHH.S.",
  ".SHHHHHHHHS.",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  "..BBBBBBBB..",
  "..BbBBBBbB..",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
  "............",
];

type Gait = "side" | "front" | "back";

/** Shirt color variants so each worker NPC is distinguishable. */
export const SHIRT_COLORS: Array<[number, number]> = [
  [0x3fc9e8, 0x2b93ad], // cyan
  [0xff4dd8, 0xb436a0], // magenta
  [0xffd166, 0xc29a3a], // yellow
  [0x37d6a3, 0x27967a], // green
  [0x9b7bff, 0x6f52c9], // purple
  [0xf29e4c, 0xb56f2f], // orange
];

export class Person {
  readonly container = new Container();
  private readonly shadow = new Graphics();
  private readonly sprite: Sprite;
  private readonly thinkDots = new Graphics();
  private readonly marker = new Graphics();
  active = false;

  private readonly idleFrames: Texture[];
  private readonly sideWalk: Texture[];
  private readonly frontWalk: Texture[];
  private readonly backWalk: Texture[];
  private readonly workFrames: Texture[];
  private readonly cheerFrame: Texture;

  x = 232;
  y = 154;
  private path: Array<{ x: number; y: number }> = [];
  private facing = 1;
  private walkCycleT = 0;

  activity: CharacterActivity = "idle";
  private animT = 0;
  private flashColor = 0xffffff;
  private flashT = 0;
  private cheerT = 0;

  private static readonly SPEED = 0.05; // art px per ms

  constructor(colorIndex = 0) {
    const [shirt, shade] = SHIRT_COLORS[colorIndex % SHIRT_COLORS.length];
    const pal = { ...PAL, B: shirt, b: shade };

    this.idleFrames = [texFromMap(FRONT_IDLE_0, pal), texFromMap(FRONT_IDLE_1, pal)];
    this.sideWalk = [
      texFromMap(SIDE_STRIDE_A, pal),
      texFromMap(SIDE_PASS, pal),
      texFromMap(SIDE_STRIDE_B, pal),
      texFromMap(SIDE_PASS, pal),
    ];
    this.frontWalk = [texFromMap(FRONT_WALK_0, pal), texFromMap(FRONT_WALK_1, pal)];
    this.backWalk = [texFromMap(BACK_WALK_0, pal), texFromMap(BACK_WALK_1, pal)];
    this.workFrames = [texFromMap(BACK_0, pal), texFromMap(BACK_TYPE_1, pal)];
    this.cheerFrame = texFromMap(CHEER, pal);

    this.sprite = new Sprite(this.idleFrames[0]);
    this.sprite.anchor.set(0.5, 1);
    this.shadow.ellipse(0, 0, 5.5, 1.8).fill({ color: 0x000000, alpha: 0.4 });
    this.container.addChild(this.shadow, this.sprite, this.thinkDots, this.marker);
  }

  /** Walk like a person in a room: horizontal leg first, then vertical. */
  setTarget(x: number, y: number): void {
    this.path = [];
    if (Math.abs(x - this.x) > 0.5) this.path.push({ x, y: this.y });
    if (Math.abs(y - this.y) > 0.5) this.path.push({ x, y });
  }

  get isMoving(): boolean {
    return this.path.length > 0;
  }

  flash(color: number, cheer: boolean): void {
    this.flashColor = color;
    this.flashT = 650;
    if (cheer) this.cheerT = 900;
  }

  update(tMs: number, dtMs: number): void {
    let dx = 0;
    let dy = 0;
    let moving = false;

    let budget = Person.SPEED * dtMs;
    while (budget > 0 && this.path.length > 0) {
      const wp = this.path[0];
      dx = wp.x - this.x;
      dy = wp.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        this.x = wp.x;
        this.y = wp.y;
        budget -= dist;
        this.path.shift();
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        budget = 0;
      }
      moving = true;
    }

    if (moving) {
      if (Math.abs(dx) > 0.5) this.facing = Math.sign(dx);
      this.walkCycleT += dtMs;
    } else {
      this.walkCycleT = 0;
    }

    if (this.flashT > 0) this.flashT -= dtMs;
    if (this.cheerT > 0) this.cheerT -= dtMs;
    this.animT += dtMs;

    let bobY = 0;
    let flip = 1;

    if (this.cheerT > 0 && !moving) {
      this.sprite.texture = this.cheerFrame;
      bobY = Math.floor(this.cheerT / 150) % 2 === 0 ? -1 : 0;
    } else if (moving) {
      const gait = this.gaitFor(dx, dy);
      if (gait === "side") {
        const idx = Math.floor(this.walkCycleT / 110) % 4;
        this.sprite.texture = this.sideWalk[idx];
        if (idx % 2 === 1) bobY = -1; // passing pose lifts the body
        flip = this.facing;
      } else {
        const frames = gait === "front" ? this.frontWalk : this.backWalk;
        const idx = Math.floor(this.walkCycleT / 130) % 2;
        this.sprite.texture = frames[idx];
        bobY = idx === 0 ? 0 : -1;
      }
    } else if (this.activity === "working") {
      const idx = Math.floor(this.animT / 200) % 2;
      this.sprite.texture = this.workFrames[idx];
    } else {
      const idx = Math.floor(this.animT / 600) % 2;
      this.sprite.texture = this.idleFrames[idx];
    }

    this.sprite.scale.x = flip;
    this.sprite.position.y = bobY;
    this.sprite.tint = this.flashT > 0 ? this.flashColor : 0xffffff;

    this.container.position.set(Math.round(this.x), Math.round(this.y));
    this.container.zIndex = this.y;

    this.drawThinkDots(tMs, moving);
    this.drawMarker(tMs);
  }

  /** Yellow pixel arrow above the active worker's head. */
  private drawMarker(tMs: number): void {
    const g = this.marker;
    g.clear();
    if (!this.active) return;
    const bob = Math.floor((tMs % 900) / 450); // 0 or 1
    const top = -24 - bob;
    g.rect(-3, top, 6, 2).fill(0xffd166);
    g.rect(-2, top + 2, 4, 2).fill(0xffd166);
    g.rect(-1, top + 4, 2, 2).fill(0xffd166);
  }

  private gaitFor(dx: number, dy: number): Gait {
    if (Math.abs(dx) >= Math.abs(dy)) return "side";
    return dy < 0 ? "back" : "front";
  }

  private drawThinkDots(tMs: number, moving: boolean): void {
    const g = this.thinkDots;
    g.clear();
    if (this.activity !== "thinking" || moving) return;
    for (let i = 0; i < 3; i++) {
      const on = Math.floor(tMs / 350) % 3 === i;
      g.rect(-3 + i * 3, -20 - (on ? 1 : 0), 1.6, 1.6).fill({
        color: 0x4de3ff,
        alpha: on ? 1 : 0.35,
      });
    }
  }
}
