import { Container, Graphics, Sprite } from "pixi.js";
import type { StationKey } from "../stations";
import { PAL, texFromMap } from "./pixels";

const BOARD = [
  "WWWWWWWWWWWWWWWWWWWW",
  "WXXXXXXXXXXXXXXXXXXW",
  "WXCC..MM..GG......XW",
  "WXCC..MM..GG..YY..XW",
  "WX................XW",
  "WXcc.cc.cc.cc.....XW",
  "WX................XW",
  "WXcc.cc...........XW",
  "WWWWWWWWWWWWWWWWWWWW",
];

const SHELF = [
  "DDDDDDDDDDDDDDDD",
  "D..............D",
  "D.OO.CC.MM.YY..D",
  "D.OO.CC.MM.YY..D",
  "DDDDDDDDDDDDDDDD",
  "D..............D",
  "D.GG.UU.RR.CC..D",
  "D.GG.UU.RR.CC..D",
  "DDDDDDDDDDDDDDDD",
  "D..............D",
  "D.YY.MM.OO.GG..D",
  "D.YY.MM.OO.GG..D",
  "DDDDDDDDDDDDDDDD",
];

const CODE_DESK = [
  "....DDDDDDDDDDDDDD....",
  "....DXXXXXXXXXXXXD....",
  "....DXCC..XX.C..XD....",
  "....DXX.CC..CXX.XD....",
  "....DXC.XX.CC...XD....",
  "....DXXX.CXX.C..XD....",
  "....DXXXXXXXXXXXXD....",
  "....DDDDDDDDDDDDDD....",
  "..........DD..........",
  "WWWWWWWWWWWWWWWWWWWWWW",
  "wwwwwwwwwwwwwwwwwwwwww",
  "..D................D..",
  "..D................D..",
  "..D................D..",
];

const RACK = [
  "DDDDDDDDDDDDDD",
  "DXXXXXXXXXXXXD",
  "DXGC........XD",
  "DXXXXXXXXXXXXD",
  "DXCG........XD",
  "DXXXXXXXXXXXXD",
  "DXGG.C......XD",
  "DXXXXXXXXXXXXD",
  "DXC..G......XD",
  "DXXXXXXXXXXXXD",
  "DXG.........XD",
  "DXXXXXXXXXXXXD",
  "DDDDDDDDDDDDDD",
  ".DD........DD.",
];

const GLOBE = [
  ".....WWWWW......",
  "...WW.....WW....",
  "..W....C....W...",
  "..W...C.C...W...",
  ".W...C..CC...W..",
  ".W..C.....C..W..",
  ".W...CC..C...W..",
  "..W....C....W...",
  "..W.........W...",
  "...WW.....WW....",
  ".....WWWWW......",
  ".......DD.......",
  "......DDDD......",
  "....DDDDDDDD....",
];

const KIOSK = [
  ".DDDDDDDDDDDD.",
  ".DXXXXXXXXXXD.",
  ".DX........XD.",
  ".DX......G.XD.",
  ".DX.....G..XD.",
  ".DXG...G...XD.",
  ".DX.G.G....XD.",
  ".DX..G.....XD.",
  ".DX........XD.",
  ".DDDDDDDDDDDD.",
  "......DD......",
  ".....DDDD.....",
];

const CRATE = [
  "DDDDDDDDDDDDDDDD",
  "D..............D",
  "D.Y..Y..Y..Y...D",
  "D..............D",
  "DDDDDDDDDDDDDDDD",
  "D..............D",
  "D.C..C..C..C...D",
  "D..............D",
  "DDDDDDDDDDDDDDDD",
];

export type FurnitureDef = {
  key: StationKey;
  label: string;
  map: string[];
  /** Center x, bottom y in the expanded 440x288 art coordinates. */
  x: number;
  bottom: number;
  /** Where the person stands to use it. */
  standX: number;
  standY: number;
  /** LED pixels (relative to sprite top-left) that blink when active. */
  leds: Array<{ x: number; y: number }>;
  onWall?: boolean;
};

export const FURNITURE_DEFS: FurnitureDef[] = [
  { key: "board", label: "任務板", map: BOARD, x: 32, bottom: 48, standX: 32, standY: 72, leds: [{ x: 3, y: 2 }, { x: 15, y: 3 }] },
  { key: "books", label: "讀檔案", map: SHELF, x: 84, bottom: 68, standX: 84, standY: 82, leds: [{ x: 3, y: 2 }, { x: 12, y: 6 }] },
  { key: "code", label: "寫程式", map: CODE_DESK, x: 136, bottom: 68, standX: 136, standY: 82, leds: [{ x: 8, y: 2 }, { x: 12, y: 4 }] },
  { key: "web", label: "上網查", map: GLOBE, x: 190, bottom: 68, standX: 190, standY: 82, leds: [{ x: 8, y: 3 }, { x: 6, y: 5 }] },
  { key: "terminal", label: "終端機", map: RACK, x: 244, bottom: 68, standX: 244, standY: 83, leds: [{ x: 2, y: 2 }, { x: 3, y: 4 }, { x: 2, y: 6 }] },
  { key: "check", label: "驗證", map: KIOSK, x: 298, bottom: 68, standX: 298, standY: 83, leds: [{ x: 3, y: 3 }, { x: 9, y: 3 }] },
  { key: "desk", label: "其他工具", map: CRATE, x: 352, bottom: 66, standX: 352, standY: 81, leds: [{ x: 2, y: 2 }, { x: 13, y: 6 }] },
  // Invisible rendezvous point around the meeting table drawn by OfficeDecor.
  { key: "meeting", label: "", map: ["."], x: 30, bottom: 94, standX: 30, standY: 107, leds: [] },
  // Home positioning and visuals are supplied by PersonalDeskLayer per Worker.
  { key: "home", label: "", map: ["."], x: 200, bottom: 220, standX: 200, standY: 232, leds: [] },
];

class FurnitureSprite {
  readonly container = new Container();
  private readonly ledOverlay = new Graphics();
  private readonly highlight = new Graphics();
  active = false;
  private readonly w: number;
  private readonly h: number;

  constructor(readonly def: FurnitureDef) {
    const sprite = new Sprite(texFromMap(def.map, PAL));
    this.w = def.map[0].length;
    this.h = def.map.length;
    sprite.anchor.set(0.5, 1);
    this.container.addChild(this.highlight, sprite, this.ledOverlay);
    this.container.position.set(def.x, def.bottom);
    this.container.zIndex = def.key === "home" ? def.bottom - 10 : def.bottom;
  }

  update(tMs: number): void {
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
        sprite.container.on("pointerover", () => this.onHover(def.key));
        sprite.container.on("pointerout", () => this.onHover(null));
        sprite.container.on("pointerdown", () => this.onSelect(def.key));
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
