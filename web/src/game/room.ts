import { Container, Graphics } from "pixi.js";
import { dayKey, tallyStrokes } from "./deskProps";

// A multiple of 32 (the wall-panel seam spacing) and 16 (the floor-tile
// spacing) so the rightmost panel/tile isn't a truncated partial segment.
export const ART_W = 448;
// 加高地板：桌子帶（BAND_BOTTOM=282）不變，底部 282~336 多出一塊空地當「作戰室會議區」，
// 讓大會議桌不會撞到任何個人桌。視野會因應變高而稍微拉遠。
export const ART_H = 336;
export const WALL_H = 52;

const WALL = 0x18213a;
const WALL_DARK = 0x131b30;
const BASEBOARD = 0x1e2a47;
const TILE_A = 0x0e1526;
const TILE_B = 0x111a2e;
const TILE_LINE = 0x18233c;
const WINDOW_FRAME = 0x2a3a60;
const WINDOW_SKY = 0x080c1a;
const STAR = 0xbfd9ff;

type Star = { x: number; y: number; phase: number };

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Clickable things on the back wall (art px rects). Purely visual reactions. */
export type RoomSpot = "clock" | "poster" | "frameA" | "frameB" | "window" | "shelf" | "whiteboard" | "aquarium" | "rack" | "hangL" | "hangR";
export const ROOM_SPOTS: Record<RoomSpot, { x: number; y: number; w: number; h: number }> = {
  clock: { x: 68, y: 9, w: 22, h: 22 },
  poster: { x: 127, y: 9, w: 16, h: 22 },
  frameA: { x: 165, y: 11, w: 20, h: 18 },
  frameB: { x: 195, y: 13, w: 22, h: 20 },
  window: { x: 246, y: 4, w: 92, h: 42 },
  shelf: { x: 348, y: 10, w: 58, h: 36 },
  whiteboard: { x: 91, y: 6, w: 34, h: 28 },
  aquarium: { x: 143, y: 32, w: 22, h: 17 },
  rack: { x: 411, y: 5, w: 28, h: 42 },
  hangL: { x: 2, y: 8, w: 13, h: 24 },
  hangR: { x: 338, y: 6, w: 10, h: 22 },
};
const SHELF_BOOKS = [0x7c5cff, 0x4de3ff, 0xff6f91, 0xffd166, 0x37d6a3, 0x8fb8e8];

/** Whiteboard doodles: each a list of [x, y, w, h, colour] strokes, drawn in one by one. */
const DOODLES: Array<Array<[number, number, number, number, number]>> = [
  // Bar chart going up, with an arrow.
  [[96, 23, 26, 1, 0x3b4a6b], [96, 10, 1, 13, 0x3b4a6b], [99, 19, 3, 4, 0x4de3ff], [104, 16, 3, 7, 0x4de3ff], [109, 14, 3, 9, 0x37d6a3], [114, 11, 3, 12, 0x37d6a3], [117, 9, 4, 1, 0xff5d73], [120, 9, 1, 3, 0xff5d73]],
  // Flowchart: box → box → diamond.
  [[95, 10, 7, 4, 0x4de3ff], [102, 12, 4, 1, 0x3b4a6b], [106, 10, 7, 4, 0x4de3ff], [109, 14, 1, 3, 0x3b4a6b], [107, 17, 5, 1, 0xff5d73], [108, 18, 3, 1, 0xff5d73], [107, 19, 5, 1, 0xff5d73], [112, 18, 6, 1, 0x3b4a6b], [118, 16, 4, 4, 0x37d6a3]],
  // Smiley and a to-do list.
  [[96, 11, 8, 1, 0x3b4a6b], [96, 19, 8, 1, 0x3b4a6b], [96, 11, 1, 9, 0x3b4a6b], [103, 11, 1, 9, 0x3b4a6b], [98, 13, 1, 1, 0x3b4a6b], [101, 13, 1, 1, 0x3b4a6b], [98, 16, 4, 1, 0xff5d73], [107, 11, 1, 1, 0x37d6a3], [109, 11, 10, 1, 0x8fa3c8], [107, 15, 1, 1, 0x37d6a3], [109, 15, 8, 1, 0x8fa3c8], [107, 19, 1, 1, 0xffb547], [109, 19, 11, 1, 0x8fa3c8]],
  // Sine wave over a grid.
  [[96, 17, 26, 1, 0xc9d4ea], [109, 9, 1, 15, 0xc9d4ea], [96, 17, 2, 1, 0x9b7bff], [98, 14, 2, 3, 0x9b7bff], [100, 12, 3, 2, 0x9b7bff], [103, 13, 2, 3, 0x9b7bff], [105, 16, 2, 3, 0x9b7bff], [107, 19, 3, 2, 0x9b7bff], [110, 18, 2, 3, 0x9b7bff], [112, 15, 2, 3, 0x9b7bff], [114, 12, 3, 2, 0x9b7bff], [117, 13, 2, 3, 0x9b7bff], [119, 16, 2, 2, 0x9b7bff]],
  // A little pixel cat.
  [[102, 13, 1, 2, 0x3b4a6b], [107, 13, 1, 2, 0x3b4a6b], [102, 15, 6, 5, 0x3b4a6b], [103, 16, 1, 1, 0xffd166], [106, 16, 1, 1, 0xffd166], [104, 18, 2, 1, 0xff9ec4], [108, 18, 6, 2, 0x3b4a6b], [114, 15, 1, 4, 0x3b4a6b], [97, 22, 24, 1, 0xc9d4ea]],
];
const DOODLE_MS = 32_000;
/** Today's 正 tally sits in a strip under the doodles (the board grew 6px for it). */
const TALLY_X = 94;
const TALLY_Y = 26;
const TALLY_COLOR = 0x5c6f94;
/** A new tally stroke is written in at the same pace as the doodle strokes. */
const TALLY_STROKE_MS = 260;

export class Room {
  readonly container = new Container();
  private readonly sky = new Graphics();
  private readonly stars = new Graphics();
  private readonly sun = new Graphics();
  private readonly moon = new Graphics();
  private readonly clockHands = new Graphics();
  private starSeeds: Star[] = [];
  // Hung on their own pins so a click can make them swing.
  private readonly poster = new Graphics();
  private readonly frameA = new Graphics();
  private readonly frameB = new Graphics();
  /** Falling book, shooting star — drawn over the wall. */
  private readonly fxG = new Graphics();
  private lastT = 0;
  private lastDate = new Date();
  private wobble: Partial<Record<RoomSpot, number>> = {};
  private spinT = 0;
  private starT = 0;
  private bookT = 0;
  // Living wall details: only these small layers redraw; the furniture itself is static.
  private readonly rackLeds = new Graphics();
  private readonly tank = new Graphics();
  private readonly doodle = new Graphics();
  private readonly hangL = new Graphics();
  private readonly hangR = new Graphics();
  private readonly weatherG = new Graphics();
  /** Static glass over the window (inner shadow, two faint glare streaks, sill) — above sky and weather. */
  private readonly glassG = new Graphics();
  /** Faint pool of window light on the floor below the counter (redrawn only on day/night/rain change). */
  private readonly floorLightG = new Graphics();
  private floorLightKey = "";
  /** Extra floor below the main office for big crews (redrawn only when its height changes). */
  private readonly annexG = new Graphics();
  private floorHeight = ART_H;
  private night = false;
  private rackBucket = -1;
  private rackStormT = 0;
  private fishDartT = 0;
  private doodleIdx = 0;
  private doodleT = 0;
  private doodleDrawn = -1;
  /** Whiteboard 正 tally of today's crew-wide completions (own layer, redrawn only when a stroke lands). */
  private readonly tallyG = new Graphics();
  private tallyTarget = 0;
  private tallyShown = 0;
  private tallyStrokeT = 0;
  private tallyDrawn = -1;
  private tallyDay = dayKey(new Date());
  private hangSway = [0, 0];
  private raining = false;
  private weatherCheck = 60_000;
  private birdsT = 0;
  private birdsNext = 14_000;
  private ufoT = 0;
  private book = 0;

  constructor() {
    const g = new Graphics();

    // Wall
    g.rect(0, 0, ART_W, WALL_H).fill(WALL);
    for (let x = 0; x < ART_W; x += 32) {
      g.rect(x, 0, 1, WALL_H).fill(WALL_DARK);
    }
    g.rect(0, WALL_H - 3, ART_W, 3).fill(BASEBOARD);

    // Wider skyline window makes the expanded room read as a larger floor.
    // Height (not just width) needs to keep pace with the taller wall, or the
    // pane reads as a flat letterbox strip instead of a proper window.
    g.rect(246, 4, 92, 42).fill(WINDOW_FRAME);
    g.rect(248, 6, 88, 38).fill(WINDOW_SKY);
    g.rect(290, 6, 2, 38).fill(WINDOW_FRAME);

    // Wall decorations: poster (on its own pin, see below) + clock
    const p = this.poster;
    p.rect(-7, 0, 14, 20).fill(0x1d1533);
    p.rect(-6, 1, 12, 18).fill(0x241a44);
    p.rect(-4, 4, 8, 5).fill(0x7c5cff);
    p.rect(-4, 11, 8, 2).fill(0xff4dd8);
    p.rect(-2, 15, 4, 2).fill(0x4de3ff);
    p.rect(-0.5, -0.5, 1, 1).fill(0x8fa3c8);
    p.position.set(135, 10);
    // 圓形掛鐘：外框＋面盤＋12/3/6/9 刻度；指針在 clockHands 圖層跟真實時間走
    g.circle(79, 20, 10).fill(0x2a3a60);
    g.circle(79, 20, 8.5).fill(0x0e1526);
    g.rect(78.5, 12, 1, 2).fill(0x3f5680);
    g.rect(78.5, 26, 1, 2).fill(0x3f5680);
    g.rect(85.5, 19.5, 2, 1).fill(0x3f5680);
    g.rect(71.5, 19.5, 2, 1).fill(0x3f5680);

    // Floor tiles
    for (let y = WALL_H; y < ART_H; y += 16) {
      for (let x = 0; x < ART_W; x += 16) {
        const odd = ((x / 16) | 0) % 2 === ((y / 16) | 0) % 2;
        g.rect(x, y, 16, 16).fill(odd ? TILE_A : TILE_B);
      }
    }
    for (let y = WALL_H; y < ART_H; y += 16) g.rect(0, y, ART_W, 1).fill(TILE_LINE);
    for (let x = 0; x < ART_W; x += 16) g.rect(x, WALL_H, 1, ART_H - WALL_H).fill(TILE_LINE);

    // Shared tools remain at the top; the larger lower floor is reserved for
    // department mats rendered by PersonalDeskLayer. Row guides are gone —
    // the department mats themselves now delineate the rows.
    g.rect(8, 88, ART_W - 16, 1).fill({ color: 0x263552, alpha: 0.8 });
    g.roundRect(10, 94, ART_W - 20, ART_H - 98, 5)
      .fill({ color: 0x0b1425, alpha: 0.2 })
      .stroke({ width: 1, color: 0x243654, alpha: 0.18 });

    // （試過鋪一塊帶邊框的中央地毯——空房間裡看起來就是兩圈突兀的框線，已拿掉。）

    // Wall furniture on the free wall spans (poster is at x128, clock x79,
    // window 246–338). A bookshelf to the right of the window and two framed
    // pictures to the left make the back wall read as a furnished office.
    // Bookshelf (right of window)
    g.rect(348, 10, 58, 36).fill(0x141b30);
    g.rect(350, 12, 54, 32).fill(0x0c1322);
    for (const shelfY of [22, 33]) g.rect(350, shelfY, 54, 1).fill(0x2a3a60);
    for (let i = 0; i < 8; i++) {
      g.rect(352 + i * 6, 14, 4, 7).fill({ color: SHELF_BOOKS[i % SHELF_BOOKS.length], alpha: 0.8 });
      g.rect(352 + i * 6, 25, 4, 7).fill({ color: SHELF_BOOKS[(i + 3) % SHELF_BOOKS.length], alpha: 0.8 });
    }
    g.rect(350, 36, 54, 6).fill(0x1a2340); // lower cabinet
    // Two framed pictures (between poster and window)
    // Drawn around their top-centre pin so a click can swing them.
    const frame = (f: Graphics, x: number, y: number, w: number, h: number, art: number) => {
      f.rect(-w / 2, 0, w, h).fill(0x243150);
      f.rect(-w / 2 + 1, 1, w - 2, h - 2).fill(0x0e1526);
      f.rect(-w / 2 + 2, 2, w - 4, h - 4).fill({ color: art, alpha: 0.6 });
      f.position.set(x + w / 2, y);
    };
    frame(this.frameA, 166, 12, 18, 16, 0x37d6a3);
    frame(this.frameB, 196, 14, 20, 18, 0xffb15c);


    // ---- Whiteboard (doodles change on their own every half minute) ----
    g.rect(91, 6, 34, 27).fill(0x8fa3c8);
    g.rect(92, 7, 32, 25).fill(0xeef3f8);
    g.rect(94, 33, 28, 1).fill(0x5c729a); // marker tray
    g.rect(97, 32, 4, 1).fill(0xff5d73);
    g.rect(103, 32, 4, 1).fill(0x4de3ff);
    // ---- Aquarium on a small wall shelf ----
    g.rect(142, 47, 24, 2).fill(0x2a3a60);
    g.rect(144, 33, 20, 14).fill(0x8fb8e8);
    g.rect(145, 34, 18, 12).fill(0x14406a);
    g.rect(145, 34, 18, 2).fill(0x1f5c8f);
    g.rect(145, 44, 18, 2).fill(0xd9c48f);
    g.rect(149, 43, 3, 1).fill(0x9aa6bd);
    // ---- Wall-mounted server rack (LEDs blink on their own layer) ----
    g.rect(411, 5, 28, 42).fill(0x0e1526);
    g.rect(412, 6, 26, 40).fill(0x1a2340);
    for (let i = 0; i < 5; i++) {
      g.rect(414, 8 + i * 7, 22, 5).fill(0x252f4f);
      g.rect(414, 8 + i * 7, 22, 1).fill(0x324066);
      for (let v = 0; v < 4; v++) g.rect(427 + v * 2, 10 + i * 7, 1, 2).fill(0x141b30);
    }
    g.rect(414, 43, 22, 1).fill(0x324066);
    // ---- Hanging plants: hook + string are static, the pots sway on their own layers ----
    g.rect(8, 0, 1, 9).fill(0x5c729a);
    g.rect(342, 0, 1, 7).fill(0x5c729a);
    drawHanging(this.hangL, 7);
    this.hangL.position.set(8, 9);
    drawHanging(this.hangR, 5);
    this.hangR.position.set(342, 7);

    this.starSeeds = Array.from({ length: 28 }, () => ({
      x: 249 + Math.random() * 86,
      y: 8 + Math.random() * 32,
      phase: Math.random() * Math.PI * 2,
    }));

    // 窗外天體：白天掛太陽、夜晚換月亮（帶兩個隕石坑的像素月）。
    this.sun.circle(268, 18, 4).fill(0xffd66b);
    this.sun.circle(268, 18, 6).fill({ color: 0xffd66b, alpha: 0.25 });
    this.moon.circle(316, 18, 4).fill(0xf3eccb);
    this.moon.circle(314.5, 16.8, 1.2).fill(0xd9d2a8);
    this.moon.circle(317.6, 19.4, 0.9).fill(0xd9d2a8);
    this.moon.visible = false;

    drawGlass(this.glassG);

    this.setSky(WINDOW_SKY);
    this.setClock(new Date());
    this.drawFloorLight();
    this.container.addChild(
      g, this.floorLightG, this.annexG, this.poster, this.frameA, this.frameB, this.sky, this.stars, this.sun, this.moon, this.weatherG,
      this.glassG, this.clockHands, this.rackLeds, this.tank, this.doodle, this.tallyG, this.hangL, this.hangR, this.fxG,
    );
  }

  /** Something on the wall was clicked: swing it, spin the clock, a shooting star, a book drops off the shelf. */
  poke(spot: RoomSpot): void {
    if (spot === "poster" || spot === "frameA" || spot === "frameB") this.wobble[spot] = 1_000;
    else if (spot === "clock") this.spinT = 1_400;
    else if (spot === "window") this.starT = 700;
    else if (spot === "rack") this.rackStormT = 1_200;
    else if (spot === "aquarium") this.fishDartT = 1_200;
    else if (spot === "whiteboard") this.doodleT = DOODLE_MS - 400; // wipe and start the next one now
    else if (spot === "hangL") this.hangSway[0] = 1_400;
    else if (spot === "hangR") this.hangSway[1] = 1_400;
    else if (spot === "shelf" && this.bookT <= 0) {
      this.bookT = 1_500;
      this.book = Math.floor(Math.random() * 8);
    }
  }

  /** 牆上時鐘走真實時間：時針＋分針，由 scene 對時（每 30 秒）呼叫重畫。 */
  setClock(date: Date): void {
    this.lastDate = date;
    // Past midnight the tally is wiped (the next setTodayCount brings the new day's number).
    const day = dayKey(date);
    if (day !== this.tallyDay) {
      this.tallyDay = day;
      this.setTodayCount(0);
    }
    if (this.spinT > 0) return; // mid-spin; snaps back to real time when it ends
    this.drawHands(date, 0);
  }

  private drawHands(date: Date, extra: number): void {
    const cx = 79;
    const cy = 20;
    const minutes = date.getMinutes();
    const hourAngle = (((date.getHours() % 12) + minutes / 60) / 12) * Math.PI * 2 + extra / 12;
    const minuteAngle = (minutes / 60) * Math.PI * 2 + extra;
    const hands = this.clockHands;
    hands.clear();
    hands.moveTo(cx, cy).lineTo(cx + Math.sin(hourAngle) * 4.5, cy - Math.cos(hourAngle) * 4.5)
      .stroke({ width: 1.4, color: 0xbfd9ff });
    hands.moveTo(cx, cy).lineTo(cx + Math.sin(minuteAngle) * 7, cy - Math.cos(minuteAngle) * 7)
      .stroke({ width: 1, color: 0x4de3ff });
    hands.circle(cx, cy, 1).fill(0xffd166);
  }

  /** 窗外天空顏色跟著日夜漸變（scene 的 applyDaylight 依關鍵影格算好顏色丟進來重畫）。 */
  setSky(color: number): void {
    this.sky.clear();
    this.sky.rect(248, 6, 88, 38).fill(color);
    this.sky.rect(290, 6, 2, 38).fill(WINDOW_FRAME); // 中間窗框蓋回天空上
  }

  /** 日夜循環：白天窗外掛太陽、星星關掉；夜晚換月亮、星星亮回來。由 scene 依真實時間呼叫。 */
  /**
   * Big crews: the floor continues below the main office — a low divider wall
   * with a wide doorway, then more tiled floor. `height` is the total floor
   * height in art px (ART_H = no annex).
   */
  setFloorHeight(height: number): void {
    const h = Math.max(ART_H, Math.round(height));
    if (h === this.floorHeight) return;
    this.floorHeight = h;
    const g = this.annexG;
    g.clear();
    if (h === ART_H) return;
    const top = ART_H;
    for (let y = top; y < h; y += 16) {
      for (let x = 0; x < ART_W; x += 16) {
        const odd = ((x / 16) | 0) % 2 === ((y / 16) | 0) % 2;
        g.rect(x, y, 16, Math.min(16, h - y)).fill(odd ? TILE_A : TILE_B);
      }
    }
    for (let y = top; y < h; y += 16) g.rect(0, y, ART_W, 1).fill(TILE_LINE);
    for (let x = 0; x < ART_W; x += 16) g.rect(x, top, 1, h - top).fill(TILE_LINE);
    // Divider: a knee-high wall with a doorway in the middle and two small lamps.
    const door = { x: ART_W / 2 - 28, w: 56 };
    g.rect(0, top, door.x, 9).fill(WALL);
    g.rect(door.x + door.w, top, ART_W - door.x - door.w, 9).fill(WALL);
    g.rect(0, top + 9, door.x, 3).fill(BASEBOARD);
    g.rect(door.x + door.w, top + 9, ART_W - door.x - door.w, 3).fill(BASEBOARD);
    g.rect(door.x - 2, top, 2, 12).fill(WINDOW_FRAME);
    g.rect(door.x + door.w, top, 2, 12).fill(WINDOW_FRAME);
    for (const lx of [door.x - 14, door.x + door.w + 12]) {
      g.rect(lx, top + 2, 3, 3).fill(0xffe2a8);
      g.rect(lx - 1, top + 5, 5, 1).fill({ color: 0xffe2a8, alpha: 0.25 });
    }
    // Same soft inner frame as the main floor so the annex reads as part of the office.
    g.roundRect(10, top + 18, ART_W - 20, h - top - 24, 5)
      .fill({ color: 0x0b1425, alpha: 0.2 })
      .stroke({ width: 1, color: 0x243654, alpha: 0.18 });
  }

  /**
   * Today's crew-wide completed count, tallied on the whiteboard in 正 strokes.
   * Going up writes the new strokes in one at a time; going down (a new day,
   * a resync) wipes straight to the new number.
   */
  setTodayCount(count: number): void {
    const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    this.tallyTarget = n;
    if (n < this.tallyShown) this.tallyShown = n;
  }

  /** One more job finished (for event-driven callers). */
  addCompletion(): void {
    this.setTodayCount(this.tallyTarget + 1);
  }

  get todayCount(): number {
    return this.tallyTarget;
  }

  /** Very rare: a flying saucer drifts past the window. */
  ufo(): void {
    this.ufoT = 3_400;
  }

  /** A few birds fly across the window (daytime). */
  birds(): void {
    this.birdsT = 5_000;
  }

  setNight(night: boolean): void {
    this.night = night;
    this.stars.visible = night;
    this.moon.visible = night;
    this.sun.visible = !night;
    this.drawFloorLight();
  }

  /**
   * Window light falling on the floor past the counter: a slanted pool in 2px
   * steps, warm by day, cool by night, barely there when it rains. Static —
   * only rebuilt when one of those changes.
   */
  private drawFloorLight(): void {
    const key = `${this.night}|${this.raining}`;
    if (key === this.floorLightKey) return;
    this.floorLightKey = key;
    const g = this.floorLightG;
    g.clear();
    const color = this.night ? 0x9fc4ff : 0xffe7b0;
    const peak = (this.night ? 0.03 : 0.045) * (this.raining ? 0.45 : 1);
    const top = 70;
    const depth = 30;
    for (let d = 0; d < depth; d += 2) {
      const shift = Math.round(d * 0.5);
      const fade = 1 - d / depth;
      // Two panes, split by the window's middle bar, like the glass above.
      g.rect(252 - shift, top + d, 36, 2).fill({ color, alpha: peak * fade });
      g.rect(294 - shift, top + d, 38, 2).fill({ color, alpha: peak * fade });
    }
  }

  update(tMs: number): void {
    const dt = Math.min(100, Math.max(0, tMs - this.lastT));
    this.lastT = tMs;
    this.updatePokes(dt);
    this.updateLiving(tMs, dt);
    const s = this.stars;
    s.clear();
    for (const star of this.starSeeds) {
      const a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(tMs * 0.001 + star.phase));
      s.rect(star.x, star.y, 1, 1).fill({ color: STAR, alpha: a });
    }
  }

  private updateLiving(tMs: number, dt: number): void {
    // Server rack LEDs: a new random pattern 7x a second (or a cascade when clicked) — not every frame.
    if (this.rackStormT > 0) this.rackStormT -= dt;
    const bucket = Math.floor(tMs / (this.rackStormT > 0 ? 50 : 140));
    if (bucket !== this.rackBucket) {
      this.rackBucket = bucket;
      const g = this.rackLeds;
      g.clear();
      for (let i = 0; i < 5; i++) {
        for (let k = 0; k < 4; k++) {
          const storm = this.rackStormT > 0;
          const on = storm ? (k + i + bucket) % 4 === 0 : noise(bucket * 7 + i * 13 + k) > 0.45;
          const color = storm ? 0xffd166 : k === 3 ? 0xffb547 : i === 2 && k === 0 ? 0x4de3ff : 0x5dff9c;
          g.rect(416 + k * 2.4, 10 + i * 7, 1.2, 1).fill({ color, alpha: on ? 1 : 0.18 });
        }
      }
    }
    // Aquarium: two fish swimming lazily (darting when tapped), bubbles, swaying weed.
    if (this.fishDartT > 0) this.fishDartT -= dt;
    const dart = this.fishDartT > 0 ? 3.2 : 1;
    const t = REDUCE_MOTION ? 0 : tMs;
    const tank = this.tank;
    tank.clear();
    const weed = Math.round(Math.sin(t / 700));
    tank.rect(160 + weed, 38, 1, 6).fill(0x37d6a3);
    tank.rect(161, 40, 1, 4).fill(0x27967a);
    for (const [phase, speed, y, color] of [[0, 1, 37, 0xf29e4c], [2.3, 0.8, 41, 0x4de3ff]] as Array<[number, number, number, number]>) {
      const s = Math.sin((t / 1_700) * speed * dart + phase);
      const fx = 154 + s * 6;
      const dir = Math.cos((t / 1_700) * speed * dart + phase) >= 0 ? 1 : -1;
      tank.rect(Math.round(fx) - 1, y, 3, 2).fill(color);
      tank.rect(Math.round(fx) - 1 - dir * 1.5, y + 0.5, 1, 1).fill(color);
      tank.rect(Math.round(fx) + dir, y, 1, 1).fill(0x0e1526);
    }
    const bubbles = this.fishDartT > 0 ? 5 : 2;
    for (let k = 0; k < bubbles; k++) {
      const q = ((t / 2_000) + k / bubbles) % 1;
      tank.rect(147 + k * 3, 44 - q * 9, 1, 1).fill({ color: 0xbff6ff, alpha: 0.8 * (1 - q * 0.6) });
    }
    // Whiteboard: wipe, then the next doodle draws itself in, stroke by stroke.
    this.doodleT += dt;
    if (this.doodleT >= DOODLE_MS) {
      this.doodleT = 0;
      this.doodleIdx = (this.doodleIdx + 1) % DOODLES.length;
    }
    const strokes = DOODLES[this.doodleIdx];
    const shown = this.doodleT < 400 ? 0 : Math.min(strokes.length, Math.floor((this.doodleT - 400) / 260) + 1);
    const wiping = this.doodleT > DOODLE_MS - 400;
    const key = wiping ? -2 : shown;
    if (key !== this.doodleDrawn) {
      this.doodleDrawn = key;
      const d = this.doodle;
      d.clear();
      if (!wiping) for (let i = 0; i < shown; i++) d.rect(...(strokes[i].slice(0, 4) as [number, number, number, number])).fill(strokes[i][4]);
    }
    // Today's tally: one stroke per completion, written in at doodle pace.
    if (this.tallyShown < this.tallyTarget) {
      this.tallyStrokeT += dt;
      if (REDUCE_MOTION || this.tallyStrokeT >= TALLY_STROKE_MS) {
        this.tallyStrokeT = 0;
        this.tallyShown = REDUCE_MOTION ? this.tallyTarget : this.tallyShown + 1;
      }
    } else {
      this.tallyStrokeT = 0;
    }
    if (this.tallyShown !== this.tallyDrawn) {
      this.tallyDrawn = this.tallyShown;
      const tg = this.tallyG;
      tg.clear();
      for (const [x, y, w, h] of tallyStrokes(this.tallyShown, TALLY_X, TALLY_Y)) tg.rect(x, y, w, h).fill(TALLY_COLOR);
    }
    // Hanging plants: barely-there sway, a proper swing when tapped.
    [this.hangL, this.hangR].forEach((g, i) => {
      if (this.hangSway[i] > 0) this.hangSway[i] -= dt;
      const p = 1 - Math.max(0, this.hangSway[i]) / 1_400;
      const kick = this.hangSway[i] > 0 ? Math.sin(p * Math.PI * 6) * 0.22 * (1 - p) : 0;
      g.rotation = REDUCE_MOTION ? 0 : kick + Math.sin(t / 2_300 + i * 2) * 0.03;
    });
    this.updateWeather(tMs, dt);
  }

  /** Window: clouds + passing birds by day, rain now and then, and the very rare UFO. */
  private updateWeather(tMs: number, dt: number): void {
    const g = this.weatherG;
    g.clear();
    this.weatherCheck -= dt;
    if (this.weatherCheck <= 0) {
      this.weatherCheck = 120_000 + Math.random() * 120_000;
      this.raining = Math.random() < 0.2;
      this.drawFloorLight();
    }
    const t = REDUCE_MOTION ? 0 : tMs;
    if (!this.night) {
      // Two soft pixel clouds drifting right, wrapping around.
      for (const [speed, y, w, off] of [[0.0012, 12, 16, 0], [0.0008, 22, 12, 50]] as Array<[number, number, number, number]>) {
        const x = 236 + (((t * speed) + off) % 112);
        const c = this.raining ? 0x8a96ad : 0xeef3f8;
        inWindow(g, x, y, w, 3, c, 0.8);
        inWindow(g, x + 3, y - 2, w - 6, 2, c, 0.8);
      }
      this.birdsNext -= dt;
      if (this.birdsNext <= 0 && !this.raining) {
        this.birdsNext = 25_000 + Math.random() * 30_000;
        this.birds();
      }
    }
    if (this.birdsT > 0) {
      this.birdsT -= dt;
      const p = 1 - this.birdsT / 5_000;
      for (let k = 0; k < 3; k++) {
        const bx = 250 + p * 100 - k * 6;
        const by = 16 + k * 3 + Math.sin(p * 20 + k) * 1.2;
        const flap = Math.floor(tMs / 160 + k) % 2;
        inWindow(g, bx - 1, by - flap, 1, 1, 0x1d2740, 1);
        inWindow(g, bx, by, 1, 1, 0x1d2740, 1);
        inWindow(g, bx + 1, by - flap, 1, 1, 0x1d2740, 1);
      }
    }
    if (this.raining) {
      inWindow(g, 248, 6, 88, 38, 0x0b1426, 0.25);
      for (let k = 0; k < 16; k++) {
        const x = 248 + ((k * 23 + Math.floor(t / 40) * 3) % 90);
        const y = 4 + ((k * 17 + t / 9) % 42);
        inWindow(g, x, y, 1, 3, 0x9fc4ff, 0.55);
      }
      // A couple of drops running down the glass.
      for (let k = 0; k < 3; k++) {
        const y = 8 + ((t / 60 + k * 13) % 34);
        inWindow(g, 258 + k * 27, y, 1, 1.5, 0xbfd9ff, 0.7);
      }
    }
    if (this.ufoT > 0) {
      this.ufoT -= dt;
      const p = 1 - this.ufoT / 3_400;
      // Drifts in, hovers with a beam flicker, then zips off up and away.
      const x = p < 0.4 ? 236 + p / 0.4 * 50 : p < 0.7 ? 286 : 286 + ((p - 0.7) / 0.3) ** 2 * 80;
      const y = p < 0.7 ? 18 + Math.sin(p * 30) : 18 - ((p - 0.7) / 0.3) * 16;
      if (p > 0.42 && p < 0.68 && Math.floor(tMs / 90) % 2 === 0) inWindow(g, x - 2, y + 2, 5, 18, 0xbfffd8, 0.25);
      inWindow(g, x - 4, y, 9, 2, 0x9aa6bd, 1);
      inWindow(g, x - 2, y - 2, 5, 2, 0x9ff3ff, 0.9);
      for (let k = 0; k < 3; k++) inWindow(g, x - 3 + k * 3, y + 1, 1, 1, Math.floor(tMs / 120 + k) % 2 ? 0xffd166 : 0xff5d73, 1);
    }
    // Keep the middle window bar on top of whatever drifted behind it.
    g.rect(290, 6, 2, 38).fill(0x2a3a60);
  }

  private updatePokes(dt: number): void {
    // Swinging on the pin: a damped wobble.
    for (const [key, g] of [["poster", this.poster], ["frameA", this.frameA], ["frameB", this.frameB]] as Array<[RoomSpot, Graphics]>) {
      const left = this.wobble[key] ?? 0;
      if (left <= 0) {
        g.rotation = 0;
        continue;
      }
      const next = left - dt;
      this.wobble[key] = next;
      const p = 1 - Math.max(0, next) / 1_000;
      g.rotation = REDUCE_MOTION ? 0 : Math.sin(p * Math.PI * 7) * 0.2 * (1 - p);
    }
    // The clock hands whizz round twice, then settle back to the real time.
    if (this.spinT > 0) {
      this.spinT -= dt;
      const p = 1 - Math.max(0, this.spinT) / 1_400;
      const eased = 1 - (1 - p) * (1 - p) * (1 - p);
      this.drawHands(this.lastDate, REDUCE_MOTION ? 0 : eased * Math.PI * 4);
      if (this.spinT <= 0) this.drawHands(this.lastDate, 0);
    }
    const g = this.fxG;
    g.clear();
    if (this.starT > 0) {
      // A shooting star streaks across the window.
      this.starT -= dt;
      const p = 1 - Math.max(0, this.starT) / 700;
      const x = 332 - p * 76;
      const y = 9 + p * 22;
      for (let k = 0; k < 7; k++) {
        const tx = x + k * 2.2;
        const ty = y - k * 0.65;
        if (tx > 335) break;
        g.rect(Math.round(tx), Math.round(ty), 1, 1).fill({ color: k === 0 ? 0xffffff : 0xbfd9ff, alpha: (1 - k / 7) * (1 - p * 0.4) });
      }
    }
    if (this.bookT > 0) {
      // A book tips off the shelf, flops onto the floor, then hops back into place.
      this.bookT -= dt;
      const p = 1 - Math.max(0, this.bookT) / 1_500;
      const bx = 352 + this.book * 6;
      const color = SHELF_BOOKS[this.book % SHELF_BOOKS.length];
      g.rect(bx, 14, 4, 7).fill(0x0c1322); // gap where it was
      let x = bx;
      let y = 14;
      let flat = false;
      if (p < 0.3) {
        const q = p / 0.3;
        y = 14 + q * q * 34;
        x = bx + q * 3;
        flat = q > 0.6;
      } else if (p < 0.65) {
        x = bx + 3;
        y = 48 - (p < 0.38 ? Math.sin(((p - 0.3) / 0.08) * Math.PI) * 2 : 0);
        flat = true;
      } else if (p < 0.92) {
        const q = (p - 0.65) / 0.27;
        x = bx + 3 * (1 - q);
        y = 48 - Math.sin(q * Math.PI) * 12 - q * 34;
      } else {
        const q = (p - 0.92) / 0.08;
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.6;
          g.rect(Math.round(bx + 2 + Math.cos(a) * (3 + q * 4)), Math.round(17 + Math.sin(a) * (3 + q * 4)), 1, 1).fill({ color: 0xfff3c4, alpha: 1 - q });
        }
        g.rect(bx, 14, 4, 7).fill({ color, alpha: 0.8 });
        return;
      }
      if (flat) g.rect(Math.round(x) - 1, Math.round(y) + 3, 7, 4).fill(color);
      else g.rect(Math.round(x), Math.round(y), 4, 7).fill(color);
    }
  }
}

/** A potted trailing plant drawn around its hanging point (0, 0). */
function drawHanging(g: Graphics, w: number): void {
  const h = w - 1;
  g.rect(-h / 2 - 0.5, 0, h + 1, 1).fill(0x8fa3c8);
  g.rect(-h / 2, 1, h, 4).fill(0xb56f2f);
  g.rect(-h / 2, 1, h, 1).fill(0xd48b4a);
  for (const [x, len, color] of [[-h / 2 - 1, 9, 0x37d6a3], [-1, 12, 0x2db88d], [h / 2, 7, 0x37d6a3]] as Array<[number, number, number]>) {
    g.rect(x, 3, 1, len).fill(color);
    g.rect(x - 1, 5 + len / 2, 1, 1).fill(0x27967a);
    g.rect(x + 1, 3 + len - 2, 1, 1).fill(0x27967a);
  }
}

/** Glass over the sky: a shadow under the top frame, two faint diagonal glare streaks, a lit sill. */
function drawGlass(g: Graphics): void {
  for (const [x0, w] of [[248, 42], [292, 44]] as Array<[number, number]>) {
    g.rect(x0, 6, w, 1).fill({ color: 0x050816, alpha: 0.35 });
    g.rect(x0, 7, w, 1).fill({ color: 0x050816, alpha: 0.12 });
  }
  g.rect(246, 44, 92, 1).fill(0x3a4d78); // sill catches the light
  g.rect(246, 45, 92, 1).fill({ color: 0x050816, alpha: 0.3 });
}

/** Rect clipped to the window glass (so weather never spills onto the wall). */
function inWindow(g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha: number): void {
  const x0 = Math.max(248, x);
  const y0 = Math.max(6, y);
  const x1 = Math.min(336, x + w);
  const y1 = Math.min(44, y + h);
  if (x1 <= x0 || y1 <= y0) return;
  g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color, alpha });
}

/** Cheap deterministic 0..1 noise. */
function noise(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
