import { Container, Graphics } from "pixi.js";

export const ART_W = 320;
export const ART_H = 180;
export const WALL_H = 46;

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
  private readonly stars = new Graphics();
  private starSeeds: Star[] = [];

  constructor() {
    const g = new Graphics();

    // Wall
    g.rect(0, 0, ART_W, WALL_H).fill(WALL);
    for (let x = 0; x < ART_W; x += 32) {
      g.rect(x, 0, 1, WALL_H).fill(WALL_DARK);
    }
    g.rect(0, WALL_H - 3, ART_W, 3).fill(BASEBOARD);

    // Window with night sky (kept left of the quest-log panel overlay)
    g.rect(178, 5, 62, 30).fill(WINDOW_FRAME);
    g.rect(180, 7, 58, 26).fill(WINDOW_SKY);
    g.rect(208, 7, 2, 26).fill(WINDOW_FRAME);

    // Wall decorations: poster + clock
    g.rect(104, 10, 14, 20).fill(0x1d1533);
    g.rect(105, 11, 12, 18).fill(0x241a44);
    g.rect(107, 14, 8, 5).fill(0x7c5cff);
    g.rect(107, 21, 8, 2).fill(0xff4dd8);
    g.rect(109, 25, 4, 2).fill(0x4de3ff);
    g.rect(58, 12, 9, 9).fill(0x2a3a60);
    g.rect(59, 13, 7, 7).fill(0x0e1526);
    g.rect(62, 14, 1, 3).fill(0xbfd9ff);
    g.rect(62, 16, 3, 1).fill(0x4de3ff);

    // Floor tiles
    for (let y = WALL_H; y < ART_H; y += 16) {
      for (let x = 0; x < ART_W; x += 16) {
        const odd = ((x / 16) | 0) % 2 === ((y / 16) | 0) % 2;
        g.rect(x, y, 16, 16).fill(odd ? TILE_A : TILE_B);
      }
    }
    for (let y = WALL_H; y < ART_H; y += 16) g.rect(0, y, ART_W, 1).fill(TILE_LINE);
    for (let x = 0; x < ART_W; x += 16) g.rect(x, WALL_H, 1, ART_H - WALL_H).fill(TILE_LINE);

    this.starSeeds = Array.from({ length: 14 }, () => ({
      x: 181 + Math.random() * 56,
      y: 8 + Math.random() * 23,
      phase: Math.random() * Math.PI * 2,
    }));

    this.container.addChild(g, this.stars);
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
