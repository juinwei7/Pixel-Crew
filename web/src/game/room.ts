import { Container, Graphics } from "pixi.js";

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

export class Room {
  readonly container = new Container();
  private readonly sky = new Graphics();
  private readonly stars = new Graphics();
  private readonly sun = new Graphics();
  private readonly moon = new Graphics();
  private readonly clockHands = new Graphics();
  private starSeeds: Star[] = [];

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

    // Wall decorations: poster + clock
    g.rect(128, 10, 14, 20).fill(0x1d1533);
    g.rect(129, 11, 12, 18).fill(0x241a44);
    g.rect(131, 14, 8, 5).fill(0x7c5cff);
    g.rect(131, 21, 8, 2).fill(0xff4dd8);
    g.rect(133, 25, 4, 2).fill(0x4de3ff);
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

    this.setSky(WINDOW_SKY);
    this.setClock(new Date());
    this.container.addChild(g, this.sky, this.stars, this.sun, this.moon, this.clockHands);
  }

  /** 牆上時鐘走真實時間：時針＋分針，由 scene 對時（每 30 秒）呼叫重畫。 */
  setClock(date: Date): void {
    const cx = 79;
    const cy = 20;
    const minutes = date.getMinutes();
    const hourAngle = (((date.getHours() % 12) + minutes / 60) / 12) * Math.PI * 2;
    const minuteAngle = (minutes / 60) * Math.PI * 2;
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
  setNight(night: boolean): void {
    this.stars.visible = night;
    this.moon.visible = night;
    this.sun.visible = !night;
  }

  update(tMs: number): void {
    const s = this.stars;
    s.clear();
    for (const star of this.starSeeds) {
      const a = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(tMs * 0.001 + star.phase));
      s.rect(star.x, star.y, 1, 1).fill({ color: STAR, alpha: a });
    }
  }
}
