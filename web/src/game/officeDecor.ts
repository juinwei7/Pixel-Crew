import { Container, Graphics } from "pixi.js";
import { ART_W } from "./room";
import type { Seasonal } from "./officeLife";
import { STATION_THEME } from "../stationTheme";

// War room (作戰室) geometry, relative to the meeting container at (120, 306).
// SEAT_X lines the chairs up with meetingSeats.ts MEETING_SEATS (standX 120 + ox),
// so NPCs gathering at the table sit on a drawn chair rather than between two.
const SEAT_X = [-33, -11, 11, 33];
// Back-row chairs are nudged a pixel here and there so the row is not a rigid grid
// (the NPC sitting there covers the backrest, so a 1px nudge never shows as a gap).
const BACK_NUDGE: Array<[number, number]> = [[-1, 0], [0, 1], [1, 0], [0, 1]];
const MEETING = { rugX: -66, rugY: -24, rugW: 132, rugH: 52, tableHalf: 44 };
const MEET_ACCENT = parseInt((STATION_THEME.meeting?.accent ?? "#8fd0ff").slice(1), 16);
const MEET = {
  // Rug: muted deep teal field, darker bound edge, one low-contrast inner line, faint weave.
  rugEdge: 0x14232a,
  rug: 0x1b2e36,
  rugLine: 0x263e46,
  rugWeave: 0x20353d,
  // Dark walnut table.
  topBack: 0x6c4b36,
  top: 0x523828,
  grain: 0x4a3224,
  sheen: 0x5e412f,
  edge: 0x7c5a40,
  lip: 0x26180f,
  face: 0x3b2519,
  toe: 0x2a1a11,
  leg: 0x21150e,
  // Chairs: same fabric as the desk chairs (person.ts drawChair) so a seated NPC's
  // own chair lands on the drawn one without a seam.
  chair: 0x2a3550,
  chairTop: 0x3d4d75,
  chairSide: 0x334166,
  chairBase: 0x1a2238,
  caster: 0x0f1526,
  // Table-top things.
  lidBack: 0x8b94a8,
  lidEdge: 0x5d667c,
  casing: 0x4a556f,
  screen: 0x0c1322,
  screenLine: mixRgb(MEET_ACCENT, 0x0c1322, 0.55),
  screenLineDim: 0x24344c,
  paper: 0xb9c1cf,
  paperBack: 0x8590a6,
  ink: 0x6c7891,
  glass: 0x7fa6c9,
  glassHi: 0xc9dcef,
  water: 0x4f7fae,
  cup: 0xd8dde6,
  cupShade: 0x9ea7b6,
  // Whiteboard on a stand + a plant.
  standMetal: 0x4a5673,
  standDark: 0x252e45,
  board: 0x9aa4b5,
  boardShade: 0x838da0,
  markerBlue: 0x4f6d99,
  markerRed: 0x96605a,
  pot: 0x4a3b33,
  potTop: 0x5d4a3f,
  leaf: 0x2f8a6d,
  leafHi: 0x3fae86,
  leafDark: 0x236852,
};

function mixRgb(a: number, b: number, t: number): number {
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t) << sh;
  return ch(16) | ch(8) | ch(0);
}

/** 1px rectangle outline on integer pixels (no stroke anti-aliasing). */
function frameRect(g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
  g.rect(x, y, w, 1).fill({ color, alpha });
  g.rect(x, y + h - 1, w, 1).fill({ color, alpha });
  g.rect(x, y + 1, 1, h - 2).fill({ color, alpha });
  g.rect(x + w - 1, y + 1, 1, h - 2).fill({ color, alpha });
}

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 3x5 pixel glyphs for the little "OUT" sign.
const GLYPHS: Record<string, string[]> = {
  O: ["###", "#.#", "#.#", "#.#", "###"],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
};

/**
 * 成品匣: the outbox shelf in the bottom-right corner. NPCs carry each new
 * deliverable here as a little box; it lights up as the box goes in. Its own
 * container (not part of OfficeDecor's) so people depth-sort around it.
 */
export class OutboxShelf {
  readonly container = new Container();
  /** Center x and floor y of the shelf, in art px. */
  readonly x = 424;
  readonly bottom = 318;
  private readonly boxesG = new Graphics();
  private readonly glowG = new Graphics();
  private count = 1;
  private glowT = 0;
  private static readonly SLOTS = 6;
  private static readonly GLOW_MS = 1_100;

  constructor() {
    this.container.position.set(this.x, this.bottom);
    this.container.zIndex = this.bottom;
    const g = new Graphics();
    // Two-tier metal cubby, 24 wide x 18 tall, on stubby legs.
    g.rect(-12, -18, 24, 18).fill(0x31416b);
    g.rect(-12, -18, 24, 2).fill(0x40577d);
    g.rect(-11, -15, 22, 6).fill(0x17223a);
    g.rect(-11, -7, 22, 6).fill(0x17223a);
    g.rect(-12, -9, 24, 1).fill(0x40577d);
    for (const x of [-4, 3]) {
      g.rect(x, -15, 1, 6).fill(0x31416b);
      g.rect(x, -7, 1, 6).fill(0x31416b);
    }
    g.rect(-11, 0, 2, 2).fill(0x23334f);
    g.rect(9, 0, 2, 2).fill(0x23334f);
    // Sign plate on top: "OUT" in neon cyan.
    g.roundRect(-8, -26, 16, 8, 1.5).fill({ color: 0x0b1226, alpha: 0.95 }).stroke({ color: 0x4de3ff, width: 0.6, alpha: 0.7 });
    let gx = -6;
    for (const ch of "OUT") {
      GLYPHS[ch].forEach((row, y) => {
        [...row].forEach((px, x) => {
          if (px === "#") g.rect(gx + x, -24.5 + y, 1, 1).fill(0x4de3ff);
        });
      });
      gx += 4;
    }
    this.container.addChild(this.glowG, g, this.boxesG);
    this.drawBoxes(-1);
  }

  /** Where an NPC stands to put a box in: beside the shelf, so the cubbies stay in view. */
  get standSpot(): { x: number; y: number } {
    return { x: this.x - 18, y: this.bottom + 1 };
  }

  /** World point just inside the shelf where the box lands (for particles). */
  get dropPoint(): { x: number; y: number } {
    const slot = Math.min(this.count, OutboxShelf.SLOTS - 1);
    const [sx, sy] = OutboxShelf.slotPos(slot);
    return { x: this.x + sx + 2.5, y: this.bottom + sy + 2 };
  }

  /** A box goes in: fill the next cubby (oldest slides out when full) and light up. */
  receive(): void {
    if (this.count >= OutboxShelf.SLOTS) this.count = OutboxShelf.SLOTS - 1;
    const slot = this.count;
    this.count += 1;
    this.glowT = OutboxShelf.GLOW_MS;
    this.drawBoxes(slot);
  }

  update(dtMs: number): void {
    const g = this.glowG;
    if (this.glowT <= 0) return;
    this.glowT -= dtMs;
    g.clear();
    if (this.glowT <= 0) {
      this.drawBoxes(-1);
      return;
    }
    const p = this.glowT / OutboxShelf.GLOW_MS; // 1 -> 0
    const a = REDUCE_MOTION ? 0.5 : p;
    g.roundRect(-14.5, -28.5, 29, 31, 3).stroke({ color: 0xffd166, width: 1, alpha: 0.75 * a });
    g.roundRect(-16, -30, 32, 34, 4).stroke({ color: 0xffd166, width: 1.6, alpha: 0.2 * a });
    g.rect(-11, -15, 22, 14).fill({ color: 0xffd166, alpha: 0.16 * a });
  }

  private static slotPos(slot: number): [number, number] {
    // Three cubbies per tier, bottom tier first.
    const col = slot % 3;
    const tier = Math.floor(slot / 3);
    return [-10 + col * 7, tier === 0 ? -6 : -14];
  }

  private drawBoxes(fresh: number): void {
    const g = this.boxesG;
    g.clear();
    for (let i = 0; i < this.count; i++) {
      const [sx, sy] = OutboxShelf.slotPos(i);
      const hot = i === fresh;
      g.rect(sx, sy + 1, 5, 4).fill(hot ? 0xf0c27e : 0xc8955a);
      g.rect(sx, sy + 1, 5, 1).fill(hot ? 0xffe2a8 : 0xe6b97c);
      g.rect(sx + 2, sy + 1, 1, 4).fill(0x8a5f33);
    }
  }
}

/** Clickable decor (art px rects). Purely visual reactions. */
export type DecorSpot = "plantL" | "plantR" | "coffee" | "neon" | "cooler" | "beanbagL" | "beanbagR" | "tree" | "pizza";
export const DECOR_SPOTS: Record<DecorSpot, { x: number; y: number; w: number; h: number }> = {
  plantL: { x: 10, y: 57, w: 12, h: 23 },
  plantR: { x: ART_W - 13, y: 57, w: 12, h: 23 },
  coffee: { x: 382, y: 66, w: 40, h: 26 },
  neon: { x: 177, y: 4, w: 58, h: 17 },
  cooler: { x: 370, y: 65, w: 12, h: 26 },
  beanbagL: { x: 244, y: 309, w: 16, h: 12 },
  beanbagR: { x: 296, y: 309, w: 16, h: 12 },
  tree: { x: 337, y: 304, w: 18, h: 28 },
  pizza: { x: 127, y: 293, w: 15, h: 11 },
};
const PLANT_X = [16, ART_W - 7];

/** Decorative office areas that do not represent agent tool destinations. */
export class OfficeDecor {
  readonly container = new Container();
  /** Plant foliage on its own layer so a click can make it sway. */
  private readonly leaves: Graphics[] = [];
  private readonly fxG = new Graphics();
  private sway = [0, 0];
  private leafT = [0, 0];
  private steamT = 0;
  private neonT = 0;
  private milestoneLevel = 0;
  // Lounge corner + water cooler + seasonal touches.
  private readonly beanbags: Graphics[] = [];
  private readonly squish = [0, 0];
  private readonly seasonG = new Graphics();
  private readonly lanterns: Graphics[] = [];
  private readonly treeG = new Graphics();
  private readonly pizzaG = new Graphics();
  private season: Seasonal = { pizza: false, xmas: false, lanterns: false, lateNight: false };
  private clock = 0;
  private glugT = 0;
  private glugNext = 15_000;
  private treeT = 0;
  private slices = 6;
  private readonly meeting = new Container();
  private readonly meetingGlow = new Graphics();
  /**
   * The war-room table itself (plus the front-row chairs and anything on the
   * table top). Not part of `container` (zIndex 132): the scene adds it straight
   * to the world at the table's front line, so back-row NPCs sit behind it and
   * front-row NPCs in front of it. The rug and back-row chairs stay low in
   * `meeting`, under everyone.
   */
  readonly meetingTable = new Container();
  private readonly meetingTableTop = new Container();
  private readonly meetingTableGlow = new Graphics();
  private readonly coffee = new Container();

  private readonly milestones: Container[] = [new Container(), new Container(), new Container()];

  constructor() {
    this.container.zIndex = 132;
    this.drawMeetingArea();
    this.drawCoffeeArea();
    this.drawPlants();
    this.drawMilestones();
    this.drawLounge();
    this.drawCooler();
    this.drawSeasonal();
    this.container.addChild(this.meeting, this.coffee, ...this.milestones, this.seasonG, this.fxG);
    this.setMilestone(0);
  }

  setWorkerCount(count: number, roundtableActive = false): void {
    // 會議桌已搬到最底部的專屬空地（不再跟部門桌搶位置），所以永遠顯示——
    // 它同時是可點擊的「作戰室」傢俱，常駐才有可發現性。
    this.meeting.visible = true;
    this.meetingTable.visible = true;
    // 開會光暈：有人在會議桌（圓桌進行中）才亮起，散會就熄燈。
    this.meetingGlow.visible = roundtableActive;
    this.meetingTableGlow.visible = roundtableActive;
  }

  /** Office growth unlocked by all-time completed turns — levels stack. */
  setMilestone(level: number): void {
    this.milestoneLevel = level;
    this.milestones.forEach((decor, index) => {
      decor.visible = level >= index + 1;
    });
  }

  private drawMilestones(): void {
    // Lv1 — framed award on the wall.
    const award = new Graphics();
    award.rect(158, 8, 12, 14).fill(0x6e5a2e);
    award.rect(159, 9, 10, 12).fill(0xf2e6c8);
    award.circle(164, 13, 2).fill(0xffd166);
    award.rect(162.6, 15.5, 1, 4).fill(0xd45c7a);
    award.rect(164.6, 15.5, 1, 4).fill(0xd45c7a);
    this.milestones[0].addChild(award);

    // Lv2 — trophy shelf.
    const shelf = new Graphics();
    shelf.rect(346, 20, 40, 3).fill(0x4a3d63);
    shelf.rect(348, 23, 2, 3).fill(0x3a3050);
    shelf.rect(382, 23, 2, 3).fill(0x3a3050);
    for (const [x, c] of [[353, 0xffd166], [365, 0xcfd8e6], [377, 0xd4915d]] as Array<[number, number]>) {
      shelf.rect(x - 3, 17, 6, 1.4).fill(c);
      shelf.rect(x - 2, 12, 4, 5).fill(c);
      shelf.rect(x - 3.6, 12.5, 1.4, 2.6).fill(c);
      shelf.rect(x + 2.2, 12.5, 1.4, 2.6).fill(c);
    }
    this.milestones[1].addChild(shelf);

    // Lv3 — neon sign over the middle of the wall.
    const neon = new Graphics();
    neon.roundRect(178, 5, 56, 15, 3).fill({ color: 0x0b1226, alpha: 0.9 }).stroke({ color: 0x4de3ff, width: 1, alpha: 0.9 });
    neon.roundRect(178, 5, 56, 15, 3).stroke({ color: 0x4de3ff, width: 2.6, alpha: 0.18 });
    // Abstract "P C" glyphs plus rising signal bars — readable at 4x zoom.
    neon.rect(184, 8, 2, 9).fill(0xff5c9d);
    neon.rect(186, 8, 4, 2).fill(0xff5c9d);
    neon.rect(188, 10, 2, 3).fill(0xff5c9d);
    neon.rect(186, 12, 2, 1).fill(0xff5c9d);
    neon.rect(195, 8, 5, 2).fill(0x4de3ff);
    neon.rect(195, 10, 2, 5).fill(0x4de3ff);
    neon.rect(195, 15, 5, 2).fill(0x4de3ff);
    for (let i = 0; i < 4; i++) {
      neon.rect(206 + i * 6, 15 - i * 2, 3, 2 + i * 2).fill({ color: 0x37d6a3, alpha: 0.5 + i * 0.12 });
    }
    this.milestones[2].addChild(neon);
  }

  private drawMeetingArea(): void {
    // 作戰室：讀起來要是「一間會議室」而不是平面圖——低彩度深青地毯（有布邊、內框與淡織紋）、
    // 深胡桃木會議桌（看得到桌面、亮桌緣、桌裙與落地陰影，兩端收圓）、跟工位同款的辦公椅
    // （椅背＋椅腳，塞在桌邊，後排略有錯落），左端一座立架白板、右上角一盆植物。
    // 全部整數像素、閒置時完全靜止；唯一的強調色是 STATION_THEME.meeting，只在開會時點亮。
    const M = MEETING;
    const rug = new Graphics();
    // Bound edge (corners clipped), field, a low-contrast inner line and a faint diamond weave.
    rug.rect(M.rugX + 1, M.rugY, M.rugW - 2, M.rugH).fill(MEET.rugEdge);
    rug.rect(M.rugX, M.rugY + 1, M.rugW, M.rugH - 2).fill(MEET.rugEdge);
    rug.rect(M.rugX + 2, M.rugY + 2, M.rugW - 4, M.rugH - 4).fill(MEET.rug);
    frameRect(rug, M.rugX + 4, M.rugY + 4, M.rugW - 8, M.rugH - 8, MEET.rugLine);
    for (let y = M.rugY + 7; y < M.rugY + M.rugH - 6; y += 2) {
      for (let x = M.rugX + 7; x < M.rugX + M.rugW - 6; x += 2) {
        if ((x + y) % 8 === 0) rug.rect(x, y, 1, 1).fill(MEET.rugWeave);
      }
    }

    // Back row: chairs facing us, backrests over the far edge of the table.
    // Drawn with the rug (below everyone) so a back-row NPC sits in front of the backrest.
    SEAT_X.forEach((sx, i) => {
      const [nx, ny] = BACK_NUDGE[i];
      const x = sx + nx;
      const top = -17 + ny;
      rug.rect(x - 4, top, 8, 1).fill(MEET.chairTop);
      rug.rect(x - 5, top + 1, 10, 5).fill(MEET.chair);
      rug.rect(x - 4, top + 1, 8, 1).fill(MEET.chairSide);
      rug.rect(x + 4, top + 1, 1, 5).fill(MEET.chairBase);
    });

    // Whiteboard on a stand at the left end of the table (a couple of muted marker strokes).
    const cx = -57;
    rug.rect(cx - 5, 0, 11, 1).fill({ color: 0x050810, alpha: 0.4 });
    rug.rect(cx - 5, -1, 4, 1).fill(MEET.standDark);
    rug.rect(cx + 2, -1, 4, 1).fill(MEET.standDark);
    rug.rect(cx - 4, -2, 9, 1).fill(MEET.standMetal);
    rug.rect(cx, -15, 1, 13).fill(MEET.standMetal);
    rug.rect(cx + 1, -15, 1, 13).fill(MEET.standDark);
    rug.rect(cx - 8, -24, 17, 10).fill(MEET.standMetal);
    rug.rect(cx - 7, -23, 15, 8).fill(MEET.board);
    rug.rect(cx - 7, -16, 15, 1).fill(MEET.boardShade);
    rug.rect(cx - 6, -14, 13, 1).fill(MEET.standDark);
    rug.rect(cx - 5, -21, 6, 1).fill(MEET.markerBlue);
    rug.rect(cx - 5, -19, 4, 1).fill(MEET.markerBlue);
    rug.rect(cx + 2, -21, 1, 4).fill(MEET.markerRed);
    rug.rect(cx + 3, -18, 3, 1).fill(MEET.markerRed);

    // Potted plant in the far right corner of the rug.
    const px = 58;
    const pb = -12; // pot rim
    rug.rect(px - 3, pb + 6, 7, 1).fill({ color: 0x050810, alpha: 0.4 });
    rug.rect(px - 3, pb + 1, 7, 5).fill(MEET.pot);
    rug.rect(px - 4, pb, 9, 1).fill(MEET.potTop);
    rug.rect(px + 3, pb + 1, 1, 5).fill(MEET.toe);
    rug.rect(px, pb - 6, 1, 6).fill(MEET.leafDark);
    rug.rect(px - 4, pb - 5, 4, 3).fill(MEET.leaf);
    rug.rect(px + 1, pb - 8, 4, 3).fill(MEET.leaf);
    rug.rect(px - 2, pb - 10, 3, 3).fill(MEET.leafHi);
    rug.rect(px + 2, pb - 3, 3, 2).fill(MEET.leafDark);
    rug.rect(px - 3, pb - 5, 2, 1).fill(MEET.leafHi);

    const g = new Graphics();
    const x0 = -M.tableHalf;
    const w = M.tableHalf * 2;
    const row = (y: number, inset: number, color: number) => g.rect(x0 + inset, y, w - inset * 2, 1).fill(color);
    // Contact shadow on the rug and the two end pedestals.
    g.rect(x0 + 2, 8, w - 4, 1).fill({ color: 0x050810, alpha: 0.45 });
    g.rect(x0 + 5, 9, w - 10, 1).fill({ color: 0x050810, alpha: 0.22 });
    g.rect(x0 + 3, 7, 3, 2).fill(MEET.leg);
    g.rect(x0 + w - 6, 7, 3, 2).fill(MEET.leg);
    // Walnut top with rounded ends: far edge catches the light, a soft sheen, a little grain.
    row(-11, 4, MEET.topBack);
    row(-10, 2, MEET.top);
    row(-9, 1, MEET.top);
    g.rect(x0, -8, w, 10).fill(MEET.top);
    g.rect(x0, -8, 1, 10).fill(MEET.sheen);
    g.rect(x0 + 1, -9, 1, 1).fill(MEET.sheen);
    g.rect(x0 + 2, -10, 1, 1).fill(MEET.sheen);
    g.rect(x0 + w - 1, -8, 1, 10).fill(MEET.grain);
    g.rect(-30, -9, 40, 1).fill(MEET.sheen);
    for (const [gx, gy, gw] of [[-38, -6, 16], [-4, -3, 24], [18, 0, 18]] as Array<[number, number, number]>) {
      g.rect(gx, gy, gw, 1).fill(MEET.grain);
    }
    // Lit bullnose edge, shadowed lip, apron, toe line.
    row(2, 1, MEET.edge);
    row(3, 1, MEET.lip);
    g.rect(x0 + 2, 4, w - 4, 3).fill(MEET.face);
    row(7, 3, MEET.toe);

    // On the table: papers, a carafe and cups, one laptop facing the back row, one facing the front.
    g.rect(-37, -8, 8, 5).fill(MEET.paperBack);
    g.rect(-36, -9, 8, 5).fill(MEET.paper);
    g.rect(-35, -7, 5, 1).fill(MEET.ink);
    g.rect(-35, -5, 4, 1).fill(MEET.ink);
    g.rect(1, -11, 3, 1).fill(MEET.lidEdge);
    g.rect(1, -10, 3, 6).fill(MEET.glass);
    g.rect(1, -7, 3, 3).fill(MEET.water);
    g.rect(1, -9, 1, 4).fill(MEET.glassHi);
    for (const [ux, uy] of [[-3, -6], [6, -7]] as Array<[number, number]>) {
      g.rect(ux, uy, 2, 1).fill(MEET.cup);
      g.rect(ux, uy + 1, 2, 1).fill(MEET.cupShade);
    }
    g.rect(28, -12, 10, 6).fill(MEET.casing);
    g.rect(29, -11, 8, 4).fill(MEET.screen);
    g.rect(30, -10, 4, 1).fill(MEET.screenLine);
    g.rect(30, -8, 5, 1).fill(MEET.screenLineDim);
    g.rect(28, -6, 10, 2).fill(MEET.lidBack);
    g.rect(29, -6, 8, 1).fill(MEET.lidEdge);
    g.rect(-16, -4, 10, 5).fill(MEET.lidBack);
    g.rect(-16, -4, 10, 1).fill(MEET.lidEdge);
    g.rect(-12, -2, 2, 1).fill(MEET.lidEdge);
    g.rect(29, -2, 6, 3).fill(MEET.paper);
    g.rect(30, -1, 4, 1).fill(MEET.ink);

    // Front row: chairs with their backs to us, tucked in against the table front.
    // Same pixels as person.ts drawChair at the seat, so a seated NPC's chair covers it exactly;
    // the two outer chairs are pulled out a pixel.
    SEAT_X.forEach((x, i) => {
      const y = i === 0 || i === SEAT_X.length - 1 ? 8 : 7;
      g.rect(x - 3, y, 6, 1).fill(MEET.chairTop);
      g.rect(x - 4, y + 1, 8, 4).fill(MEET.chair);
      g.rect(x - 4, y + 1, 1, 4).fill(MEET.chairSide);
      g.rect(x, y + 5, 1, 1).fill(MEET.chairBase);
      g.rect(x - 4, y + 6, 8, 1).fill(MEET.chairBase);
      g.rect(x - 3, y + 7, 6, 1).fill({ color: 0x050810, alpha: 0.35 });
      g.rect(x - 4, y + 7, 1, 1).fill(MEET.caster);
      g.rect(x + 3, y + 7, 1, 1).fill(MEET.caster);
    });

    // ---- 開會中（地毯布邊、桌緣與螢幕換成作戰室主題色；靜態，不閃不動） ----
    const glow = this.meetingGlow;
    frameRect(glow, M.rugX + 1, M.rugY + 1, M.rugW - 2, M.rugH - 2, MEET_ACCENT, 0.35);
    glow.rect(cx - 5, -21, 6, 1).fill(MEET_ACCENT);
    glow.visible = false;
    const tableGlow = this.meetingTableGlow;
    tableGlow.rect(x0 + 1, 2, w - 2, 1).fill({ color: MEET_ACCENT, alpha: 0.6 });
    tableGlow.rect(30, -10, 4, 1).fill(MEET_ACCENT);
    tableGlow.visible = false;

    // 放到畫面最底下的空地，NPC 會走過來圍著它討論（避開上方部門排，才不會擠在一起）。
    this.meeting.position.set(120, 306);
    this.meeting.addChild(rug, glow);
    this.meetingTableTop.position.set(120, 306);
    this.meetingTableTop.addChild(g, tableGlow);
    // Depth line = the table's front face (306 + 8): back row (feet at 300) sorts
    // behind it, front row (feet at 320) in front.
    this.meetingTable.zIndex = 306 + 8;
    this.meetingTable.addChild(this.meetingTableTop);
  }

  private drawCoffeeArea(): void {
    const g = new Graphics();
    g.rect(-19, -17, 38, 17).fill(0x2b3d5c);
    g.rect(-19, -17, 38, 3).fill(0x40577d);
    g.rect(-13, -14, 12, 10).fill(0x111b30);
    g.rect(-11, -12, 8, 5).fill(0x1d2c48);
    g.rect(-9, -11, 4, 1).fill(0x37d6a3);
    g.rect(5, -11, 5, 6).fill(0x17223a);
    g.rect(11, -10, 4, 5).fill(0x17223a);
    g.rect(6, -9, 3, 1).fill(0xffd166);
    g.rect(12, -8, 2, 1).fill(0x4de3ff);
    g.rect(-16, 0, 3, 7).fill(0x23334f);
    g.rect(13, 0, 3, 7).fill(0x23334f);

    this.coffee.position.set(402, 84);
    this.coffee.addChild(g);
  }

  private drawPlants(): void {
    const g = new Graphics();
    for (const x of PLANT_X) {
      g.rect(x - 4, 73, 8, 6).fill(0x354566);
      g.rect(x - 3, 71, 6, 4).fill(0x273957);
      // Foliage hangs off the soil line (y 72) so skewing it sways the plant from its base.
      const leaves = new Graphics();
      leaves.rect(-1, -8, 2, 8).fill(0x27967a);
      leaves.rect(-5, -8, 5, 3).fill(0x37d6a3);
      leaves.rect(0, -11, 5, 4).fill(0x37d6a3);
      leaves.rect(-4, -13, 4, 4).fill(0x2db88d);
      leaves.position.set(x, 72);
      this.leaves.push(leaves);
    }
    this.container.addChild(g, ...this.leaves);
  }

  /** Lounge corner beside the meeting room: a striped rug and two beanbags. */
  private drawLounge(): void {
    const rug = new Graphics();
    rug.roundRect(234, 302, 88, 24, 4).fill(0x26304f);
    rug.roundRect(234, 302, 88, 24, 4).stroke({ width: 1, color: 0x3b4a6b });
    for (let x = 242; x < 318; x += 10) rug.rect(x, 306, 4, 16).fill({ color: 0x323e63, alpha: 0.8 });
    this.container.addChild(rug);
    for (const [x, color, shade] of [[252, 0x9b7bff, 0x6f52c9], [304, 0x37d6a3, 0x27967a]] as Array<[number, number, number]>) {
      const b = new Graphics();
      b.ellipse(0, -4, 7, 5).fill(shade);
      b.ellipse(0, -5, 6, 4).fill(color);
      b.rect(-3, -8, 3, 1).fill({ color: 0xffffff, alpha: 0.35 });
      b.position.set(x, 320);
      this.beanbags.push(b);
      this.container.addChild(b);
    }
  }

  /** Water cooler by the coffee corner. */
  private drawCooler(): void {
    const g = new Graphics();
    g.rect(371, 77, 10, 13).fill(0x3a4766);
    g.rect(371, 77, 10, 1).fill(0x4d5d85);
    g.rect(373, 81, 1, 1).fill(0x4de3ff);
    g.rect(378, 81, 1, 1).fill(0xff5d73);
    g.rect(372, 89, 2, 2).fill(0x23334f);
    g.rect(378, 89, 2, 2).fill(0x23334f);
    g.rect(372, 66, 8, 11).fill({ color: 0x6fb6ff, alpha: 0.55 });
    g.rect(372, 69, 8, 8).fill({ color: 0x4d9be6, alpha: 0.6 });
    g.rect(373, 67, 1, 9).fill({ color: 0xffffff, alpha: 0.35 });
    g.rect(374, 65, 4, 1).fill(0x8fb8e8);
    this.container.addChild(g);
  }

  /** Seasonal pieces, built once and only shown when the calendar says so. */
  private drawSeasonal(): void {
    // Christmas tree in the lounge corner (ornaments twinkle in update).
    const t = this.treeG;
    t.rect(344, 326, 4, 4).fill(0x8a5f33);
    t.poly([346, 306, 338, 318, 354, 318]).fill(0x27967a);
    t.poly([346, 310, 336, 324, 356, 324]).fill(0x2db88d);
    t.poly([346, 314, 337, 327, 355, 327]).fill(0x27967a);
    t.rect(345, 303, 2, 2).fill(0xffd166);
    t.visible = false;
    // Red lanterns hanging from the ceiling.
    for (const x of [52, 154, 444]) {
      const l = new Graphics();
      l.rect(-0.5, 0, 1, 6).fill(0xc29a3a);
      l.rect(-2, 6, 4, 1).fill(0xffd166);
      l.ellipse(0, 10, 3, 3.5).fill(0xe0393f);
      l.rect(-0.5, 7, 1, 6).fill({ color: 0xff7a6b, alpha: 0.6 });
      l.rect(-2, 13, 4, 1).fill(0xffd166);
      l.rect(-0.5, 14, 1, 3).fill(0xff5d73);
      l.position.set(x, 0);
      l.visible = false;
      this.lanterns.push(l);
    }
    this.pizzaG.visible = false;
    this.drawPizza();
    this.seasonG.addChild(this.treeG, ...this.lanterns);
    // The pizza box sits on the war-room table, so it lives (and depth-sorts) with the table.
    this.meetingTable.addChild(this.pizzaG);
  }

  private drawPizza(): void {
    const g = this.pizzaG;
    g.clear();
    // Open box on the meeting table, slices missing as people help themselves.
    g.rect(128, 294, 13, 9).fill(0xc8955a);
    g.rect(129, 295, 11, 7).fill(0xe6b97c);
    g.circle(134.5, 298.5, 3.3).fill(0xffd166);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const px = 134.5 + Math.cos(a + 0.5) * 1.8;
      const py = 298.5 + Math.sin(a + 0.5) * 1.8;
      if (i >= this.slices) g.circle(px, py, 1.4).fill(0xe6b97c);
      else g.rect(Math.round(px), Math.round(py), 1, 1).fill(0xe0393f);
    }
  }

  private updateLounge(g: Graphics, dtMs: number): void {
    // Beanbags squish when sat on (tapped).
    this.beanbags.forEach((b, i) => {
      if (this.squish[i] > 0) this.squish[i] -= dtMs;
      const p = 1 - Math.max(0, this.squish[i]) / 700;
      const s = this.squish[i] > 0 && !REDUCE_MOTION ? Math.sin(p * Math.PI * 3) * 0.18 * (1 - p) : 0;
      b.scale.set(1 + s, 1 - s);
    });
    // Water cooler glugs a bubble up now and then.
    this.glugNext -= dtMs;
    if (this.glugNext <= 0) {
      this.glugNext = 14_000 + Math.random() * 12_000;
      this.glugT = 900;
    }
    if (this.glugT > 0) {
      this.glugT -= dtMs;
      const q = 1 - Math.max(0, this.glugT) / 1_200;
      for (let k = 0; k < 3; k++) {
        const y = 76 - ((q * 12 + k * 3) % 10);
        g.rect(374 + k * 2, Math.round(y), 1, 1).fill({ color: 0xdff6ff, alpha: 0.8 });
      }
    }
    // Christmas lights and swaying lanterns.
    if (this.season.xmas) {
      const tw = this.treeT > 0 ? 80 : 420;
      if (this.treeT > 0) this.treeT -= dtMs;
      const lights: Array<[number, number, number]> = [[342, 316, 0xff5d73], [349, 314, 0x4de3ff], [340, 322, 0xffd166], [351, 321, 0xff4dd8], [345, 325, 0x9dff9c], [346, 311, 0xffd166]];
      lights.forEach(([x, y, c], i) => {
        const on = REDUCE_MOTION || Math.floor(this.clock / tw + i) % 3 !== 0;
        g.rect(x, y, 1, 1).fill({ color: c, alpha: on ? 1 : 0.3 });
      });
      if (this.treeT > 0) g.rect(344, 302, 4, 4).fill({ color: 0xfff3c4, alpha: 0.4 }); // the star flares
    }
    if (this.season.lanterns && !REDUCE_MOTION) {
      this.lanterns.forEach((l, i) => { l.rotation = Math.sin(this.clock / 1_400 + i * 1.7) * 0.06; });
    }
  }

  /** Is the neon sign (milestone 3) on the wall? */
  get neonShown(): boolean {
    return this.milestoneLevel >= 3;
  }

  /** Clicked: the plant sways and drops a leaf, the coffee machine puffs steam, the neon sign sputters. */
  poke(spot: DecorSpot): void {
    if (spot === "plantL" || spot === "plantR") {
      const i = spot === "plantL" ? 0 : 1;
      this.sway[i] = 1_100;
      this.leafT[i] = 1_300;
    } else if (spot === "coffee") {
      this.steamT = 1_600;
    } else if (spot === "cooler") {
      this.glugT = 1_200;
    } else if (spot === "beanbagL" || spot === "beanbagR") {
      this.squish[spot === "beanbagL" ? 0 : 1] = 700;
    } else if (spot === "tree") {
      this.treeT = 1_500;
    } else if (spot === "pizza") {
      // Someone grabs a slice (the box refills when it's empty).
      this.slices = this.slices <= 1 ? 6 : this.slices - 1;
      this.drawPizza();
    } else if (spot === "neon" && this.neonShown) {
      this.neonT = 1_000;
    }
  }

  /** Calendar touches (officeLife.seasonal): Friday pizza, a Christmas tree, New Year lanterns. */
  setSeasonal(s: Seasonal): void {
    if (s.pizza === this.season.pizza && s.xmas === this.season.xmas && s.lanterns === this.season.lanterns) return;
    this.season = s;
    this.pizzaG.visible = s.pizza;
    this.treeG.visible = s.xmas;
    for (const l of this.lanterns) l.visible = s.lanterns;
  }

  get seasonNow(): Seasonal {
    return this.season;
  }

  update(dtMs: number): void {
    const g = this.fxG;
    g.clear();
    this.clock += dtMs;
    this.updateLounge(g, dtMs);
    this.leaves.forEach((leaves, i) => {
      if (this.sway[i] > 0) this.sway[i] -= dtMs;
      const p = 1 - Math.max(0, this.sway[i]) / 1_100;
      leaves.skew.x = this.sway[i] > 0 && !REDUCE_MOTION ? Math.sin(p * Math.PI * 6) * 0.35 * (1 - p) : 0;
      if (this.leafT[i] > 0) {
        // A single leaf flutters down to the floor.
        this.leafT[i] -= dtMs;
        const q = 1 - Math.max(0, this.leafT[i]) / 1_300;
        const dir = i === 0 ? 1 : -1;
        const lx = PLANT_X[i] + dir * (3 + q * 9) + Math.sin(q * Math.PI * 4) * 1.5;
        const ly = 61 + q * 22;
        g.rect(Math.round(lx), Math.round(ly), 2, 1).fill({ color: 0x37d6a3, alpha: q > 0.8 ? (1 - q) / 0.2 : 1 });
        g.rect(Math.round(lx) + (Math.floor(q * 8) % 2), Math.round(ly) - 1, 1, 1).fill({ color: 0x2db88d, alpha: q > 0.8 ? (1 - q) / 0.2 : 1 });
      }
    });
    if (this.steamT > 0) {
      // Steam puffs out of the machine and the little ready light blinks.
      this.steamT -= dtMs;
      const t = 1_600 - Math.max(0, this.steamT);
      for (let k = 0; k < 4; k++) {
        const age = t - k * 220;
        if (age < 0 || age > 900) continue;
        const q = age / 900;
        g.circle(395 + Math.sin(q * 5 + k) * 1.5 + (k % 2), 69 - q * 13, 1.2 + q * 2.2).fill({ color: 0xdfe9f8, alpha: 0.55 * (1 - q) });
      }
      if (Math.floor(t / 150) % 2 === 0) g.rect(408, 75, 2, 1).fill(0xffd166);
    }
    if (this.neonT > 0) {
      // Neon sign sputters off and on like a loose tube.
      this.neonT -= dtMs;
      const t = 1_000 - Math.max(0, this.neonT);
      const on = REDUCE_MOTION || this.neonT <= 0 || !(t < 90 || (t > 180 && t < 260) || (t > 330 && t < 520) || (t > 600 && t < 650));
      this.milestones[2].alpha = on ? 1 : 0.15;
    }
  }
}
