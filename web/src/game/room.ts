import { Container, Graphics } from "pixi.js";

// A multiple of 32 (the wall-panel seam spacing) and 16 (the floor-tile
// spacing) so the rightmost panel/tile isn't a truncated partial segment.
export const ART_W = 448;
export const ART_H = 288;
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
    g.rect(74, 12, 9, 9).fill(0x2a3a60);
    g.rect(75, 13, 7, 7).fill(0x0e1526);
    g.rect(78, 14, 1, 3).fill(0xbfd9ff);
    g.rect(78, 16, 3, 1).fill(0x4de3ff);

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

    this.starSeeds = Array.from({ length: 14 }, () => ({
      x: 249 + Math.random() * 86,
      y: 8 + Math.random() * 32,
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
