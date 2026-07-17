import { Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import { GifSprite, type GifSource } from "pixi.js/gif";
import type { CharacterActivity } from "../types";
import { texFromMap } from "./pixels";
import { avatarPresetPalette, avatarPresetRows } from "./avatarPresets";

// ---------- Front (facing camera) ----------

export const FRONT_IDLE_0 = [
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

export type EmoteKind = "question" | "cloud" | "chat" | "coffee";

export class Person {
  readonly container = new Container();
  private readonly shadow = new Graphics();
  private readonly sprite: Sprite;
  private readonly thinkDots = new Graphics();
  private readonly marker = new Graphics();
  private readonly emoteG = new Graphics();
  private emoteKind: EmoteKind | null = null;
  private emoteT = 0;
  active = false;

  private idleFrames: Texture[];
  private sideWalk: Texture[];
  private frontWalk: Texture[];
  private backWalk: Texture[];
  private workFrames: Texture[];
  private cheerFrame: Texture;
  private presetKey: string;
  private customTexture: Texture | null = null;
  private gifSprite: GifSprite | null = null;
  private customScale = 1;
  private avatarLoadVersion = 0;
  private avatarUrl: string | null = null;
  private destroyed = false;

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

  constructor(colorIndex = 0, presetId = "classic") {
    const frames = createPresetFrames(presetId, colorIndex);
    this.idleFrames = frames.idleFrames;
    this.sideWalk = frames.sideWalk;
    this.frontWalk = frames.frontWalk;
    this.backWalk = frames.backWalk;
    this.workFrames = frames.workFrames;
    this.cheerFrame = frames.cheerFrame;
    this.presetKey = `${presetId}:${colorIndex}`;

    this.sprite = new Sprite(this.idleFrames[0]);
    this.sprite.anchor.set(0.5, 1);
    this.shadow.ellipse(0, 0, 5.5, 1.8).fill({ color: 0x000000, alpha: 0.4 });
    this.container.addChild(this.shadow, this.sprite, this.thinkDots, this.marker, this.emoteG);
  }

  setPreset(presetId: string, colorIndex: number): void {
    const nextKey = `${presetId}:${colorIndex}`;
    if (nextKey === this.presetKey) return;
    const previous = this.presetTextures();
    const frames = createPresetFrames(presetId, colorIndex);
    this.idleFrames = frames.idleFrames;
    this.sideWalk = frames.sideWalk;
    this.frontWalk = frames.frontWalk;
    this.backWalk = frames.backWalk;
    this.workFrames = frames.workFrames;
    this.cheerFrame = frames.cheerFrame;
    this.presetKey = nextKey;
    if (!this.customTexture) this.sprite.texture = this.idleFrames[0];
    for (const texture of previous) texture.destroy(true);
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

  /** Cheer pose without the colour flash — e.g. neighbours applauding. */
  cheer(): void {
    this.cheerT = 900;
  }

  /** Pixel emote bubble above the head; ms <= 0 clears it. */
  emote(kind: EmoteKind, ms: number): void {
    if (ms <= 0) {
      this.emoteKind = null;
      this.emoteT = 0;
      this.emoteG.clear();
      return;
    }
    this.emoteKind = kind;
    this.emoteT = ms;
  }

  get emoting(): EmoteKind | null {
    return this.emoteKind;
  }

  async setAvatar(url: string | null): Promise<string | null> {
    const version = ++this.avatarLoadVersion;
    await this.releaseAvatar();
    if (this.destroyed || version !== this.avatarLoadVersion) return null;
    this.sprite.visible = true;
    if (!url) {
      this.customTexture = null;
      this.customScale = 1;
      return null;
    }
    this.customTexture = null;
    try {
      if (url.toLowerCase().endsWith(".gif")) {
        const source = await Assets.load<GifSource>({
          src: url,
          data: { fps: 20, scaleMode: "nearest", autoGenerateMipmaps: false },
        });
        const gif = new GifSprite({ source, autoPlay: true, loop: true, autoUpdate: true });
        if (!this.destroyed && version === this.avatarLoadVersion) {
          gif.anchor.set(0.5, 1);
          this.gifSprite = gif;
          this.avatarUrl = url;
          this.customScale = Math.min(12 / source.width, 16 / source.height);
          this.sprite.visible = false;
          this.container.addChildAt(gif, 1);
        } else {
          gif.destroy();
          await unloadAvatar(url);
        }
      } else {
        const texture = await Assets.load<Texture>(url);
        if (!this.destroyed && version === this.avatarLoadVersion) {
          this.customTexture = texture;
          this.avatarUrl = url;
          this.customScale = Math.min(12 / texture.width, 16 / texture.height);
        } else {
          await unloadAvatar(url);
        }
      }
      return null;
    } catch (error) {
      await unloadAvatar(url);
      if (!this.destroyed && version === this.avatarLoadVersion) {
        this.customTexture = null;
        this.sprite.visible = true;
        return `無法載入自訂角色：${(error as Error).message || "圖片解碼失敗"}`;
      }
      return null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.avatarLoadVersion++;
    const url = this.avatarUrl;
    this.avatarUrl = null;
    this.clearGifSprite();
    this.customTexture = null;
    if (url) void unloadAvatar(url);
    this.container.destroy({ children: true });
    for (const texture of this.presetTextures()) {
      texture.destroy(true);
    }
  }

  private presetTextures(): Set<Texture> {
    return new Set([
      ...this.idleFrames,
      ...this.sideWalk,
      ...this.frontWalk,
      ...this.backWalk,
      ...this.workFrames,
      this.cheerFrame,
    ]);
  }

  private async releaseAvatar(): Promise<void> {
    const url = this.avatarUrl;
    this.avatarUrl = null;
    this.clearGifSprite();
    this.sprite.texture = this.idleFrames[0];
    this.sprite.visible = true;
    this.customTexture = null;
    this.customScale = 1;
    if (url) await unloadAvatar(url);
  }

  private clearGifSprite(): void {
    if (!this.gifSprite) return;
    this.gifSprite.stop();
    this.gifSprite.destroy();
    this.gifSprite = null;
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

    if (this.customTexture) {
      this.sprite.texture = this.customTexture;
      if (moving) {
        const sideMovement = Math.abs(dx) >= Math.abs(dy);
        flip = sideMovement ? this.facing : 1;
        bobY = Math.floor(this.walkCycleT / 130) % 2 === 0 ? 0 : -1;
      } else if (this.cheerT > 0) {
        bobY = Math.floor(this.cheerT / 150) % 2 === 0 ? -1 : 0;
      } else if (this.activity === "working") {
        bobY = Math.floor(this.animT / 260) % 2 === 0 ? 0 : -1;
      }
    }

    const visual = this.gifSprite ?? this.sprite;
    const avatarScale = this.customTexture || this.gifSprite ? this.customScale : 1;
    visual.scale.set(flip * avatarScale, avatarScale);
    visual.position.y = bobY;
    visual.tint = this.flashT > 0 ? this.flashColor : 0xffffff;

    this.container.position.set(Math.round(this.x), Math.round(this.y));
    this.container.zIndex = this.y;

    if (this.emoteT > 0) {
      this.emoteT -= dtMs;
      if (this.emoteT <= 0) {
        this.emoteKind = null;
        this.emoteG.clear();
      }
    }

    this.drawThinkDots(tMs, moving);
    this.drawMarker(tMs);
    this.drawEmote(tMs);
  }

  /** Small pixel-art emote hovering above the head. */
  private drawEmote(tMs: number): void {
    const g = this.emoteG;
    g.clear();
    if (!this.emoteKind) return;
    const bob = Math.floor((tMs % 800) / 400); // 0 or 1
    const top = -27 - bob;
    if (this.emoteKind === "question") {
      // Yellow "?" built from pixels.
      g.rect(-2, top, 4, 1.4).fill(0xffd166);
      g.rect(1, top + 1.4, 1.4, 1.6).fill(0xffd166);
      g.rect(-0.4, top + 3, 1.8, 1.4).fill(0xffd166);
      g.rect(-0.4, top + 5.2, 1.6, 1.6).fill(0xffd166);
    } else if (this.emoteKind === "cloud") {
      // Grey storm cloud with a couple of rain pixels.
      g.ellipse(-2, top + 2.5, 3, 2).fill(0x5a6a83);
      g.ellipse(1.6, top + 2, 2.6, 2.2).fill(0x677894);
      g.ellipse(0, top + 3.4, 4.2, 1.8).fill(0x4d5c74);
      const drip = Math.floor(tMs / 320) % 2;
      g.rect(-2.5, top + 5.6 + drip, 1, 1.4).fill(0x4de3ff);
      g.rect(1.5, top + 6.2 - drip, 1, 1.4).fill(0x4de3ff);
    } else if (this.emoteKind === "chat") {
      // Tiny speech bubble with animated dots.
      g.roundRect(-4.5, top, 9, 5.4, 1.6).fill({ color: 0x0d1a30, alpha: 0.92 }).stroke({ color: 0x4de3ff, width: 0.5, alpha: 0.6 });
      g.rect(-1, top + 5.4, 1.6, 1.2).fill({ color: 0x0d1a30, alpha: 0.92 });
      const active = Math.floor(tMs / 300) % 3;
      for (let i = 0; i < 3; i++) {
        g.rect(-2.6 + i * 2.2, top + 2.2, 1.2, 1.2).fill({ color: 0x9eeaff, alpha: i === active ? 1 : 0.4 });
      }
    } else if (this.emoteKind === "coffee") {
      // Mug with rising steam.
      g.rect(-2, top + 2.4, 4, 3.4).fill(0xb56f2f);
      g.rect(2, top + 3, 1.2, 1.8).fill(0xb56f2f);
      g.rect(-2, top + 2.4, 4, 0.9).fill(0x6e4218);
      const s = Math.floor(tMs / 260) % 2;
      g.rect(-1.4, top + s * 0.6, 0.9, 1.2).fill({ color: 0xcfe3f7, alpha: 0.8 });
      g.rect(0.6, top + 1 - s * 0.6, 0.9, 1.2).fill({ color: 0xcfe3f7, alpha: 0.8 });
    }
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

function createPresetFrames(presetId: string, colorIndex: number) {
  const pal = avatarPresetPalette(presetId, colorIndex, SHIRT_COLORS);
  const tex = (rows: string[]) => texFromMap(avatarPresetRows(rows, presetId), pal);
  return {
    idleFrames: [tex(FRONT_IDLE_0), tex(FRONT_IDLE_1)],
    sideWalk: [
      tex(SIDE_STRIDE_A),
      tex(SIDE_PASS),
      tex(SIDE_STRIDE_B),
      tex(SIDE_PASS),
    ],
    frontWalk: [tex(FRONT_WALK_0), tex(FRONT_WALK_1)],
    backWalk: [tex(BACK_WALK_0), tex(BACK_WALK_1)],
    workFrames: [tex(BACK_0), tex(BACK_TYPE_1)],
    cheerFrame: tex(CHEER),
  };
}

async function unloadAvatar(url: string): Promise<void> {
  try {
    await Assets.unload(url);
  } catch {
    // The load may have failed before the URL entered Pixi's cache.
  }
}
