// Station furniture: pixel maps, positions and labels. Plain data (no Pixi)
// so the app entry can place station tooltips before the office scene loads.
import type { StationKey } from "../stations";
import { t } from "../i18n";

// 任務板: a wall-mounted kanban in the same station kit (K casing / L lit top
// edge / X dark surface). Three columns — to do (w cards), doing (one A card in
// the board accent + a q card), done (D, dimmest) — over a marker tray.
const BOARD = [
  "LLLLLLLLLLLLLLLLLLLLLLLL",
  "KXXXXXXXXXXXXXXXXXXXXXXK",
  "KXwwwwwwdqqqqqqdwwwwwwXK",
  "KXXXXXXXdXXXXXXdXXXXXXXK",
  "KXXwwwwXdXAAAAXdXDDDDXXK",
  "KXXwwwwXdXAAAAXdXDDDDXXK",
  "KXXXXXXXdXXXXXXdXXXXXXXK",
  "KXXwwwwXdXqqqqXdXDDDDXXK",
  "KXXwwwwXdXqqqqXdXDDDDXXK",
  "KXXXXXXXdXXXXXXdXXXXXXXK",
  "KXXwwwwXdXXXXXXdXDDDDXXK",
  "KXXwwwwXdXXXXXXdXDDDDXXK",
  "KXXXXXXXdXXXXXXdXXXXXXXK",
  "KKKKKKKKKKKKKKKKKKKKKKKK",
  ".kkkkkkkkkkkkkkkkkWWkkk.",
];

// The six tool stations share one kit: ~18px tall, the same casing (K body /
// k shade / L edge) and screen (X), standing on the shared counter that
// FurnitureLayer draws along the back wall. A / q are filled per station with
// its STATION_THEME accent and a dimmed accent, so the set reads as one family
// while each station keeps its own colour.
// Device rows end on the counter top; the transparent rows below cover the
// counter front, so the hover/click area spans the station's counter section.
const COUNTER_ROWS = 10;
const onCounter = (rows: string[]): string[] => [...rows, ...Array.from({ length: COUNTER_ROWS }, () => ".".repeat(rows[0].length))];

const SHELF = onCounter([
  "LLLLLLLLLLLLLLLLLLLL",
  "KkkkkkkkkkkkkkkkkkkK",
  "KkkAkkkWkkkkAkkqkkkK",
  "KkqAkwkWkAkqAkwqAkkK",
  "KkqAwwqWkAqqAwwqAWkK",
  "KkqAwwqWqAqqAwwqAWkK",
  "KkqAwwqWqAqqAwwqAWkK",
  "KkqAwwqWqAqqAwwqAWkK",
  "KLLLLLLLLLLLLLLLLLLK",
  "KkkkkkkkkkkkkkkkkkkK",
  "KkWkkkAkkkqkkkAkkkkK",
  "KkWAkkAkwkqAkkAqkkkK",
  "KkWAqkAwwkqAWkAqwkkK",
  "KkWAqAAwwqqAWkAqwAkK",
  "KkWAqAAwwqqAWwAqwAkK",
  "KkWAqAAwwqqAWwAqwAkK",
  "KLLLLLLLLLLLLLLLLLLK",
  "kkkkkkkkkkkkkkkkkkkk",
]);

const CODE_DESK = onCounter([
  ".KKKKKKKKKKKKKKKK.",
  ".KXXXXXXXXXXXXXXK.",
  ".KXAAqXqqqqXXXXXK.",
  ".KXXXAAAqXqqXXXXK.",
  ".KXXXqqXAAAAqXXXK.",
  ".KXXXXXqqXqXXXXXK.",
  ".KXAqXqqqqXXXXXXK.",
  ".KXXXAAqXAqXXXXXK.",
  ".KXXXXXXXXXXXXXXK.",
  ".KXAXXXXXXXXXXXXK.",
  ".KXXXXXXXXXXXXXXK.",
  ".KKKKKKKKKKKKKKKK.",
  ".kkkkkkkkkkkkkkkk.",
  "........KK........",
  "......KKKKKK......",
  "..................",
  "..LKLKLKLKLKLKLK..",
  "..KKKKKKKKKKKKKK..",
]);

const GLOBE = onCounter([
  ".......kkkkkk.......",
  ".....kkqqqAAkk......",
  "....kqqqqAAAAqk.....",
  "...kqWAAqqqAAqqk....",
  "...kAAAAAqqqqqAk.L..",
  "..kqAAAAAqqqqqAAkL..",
  "..kqqAAAqqqqqAAAkL..",
  "..kqqqAqqqqqAAAqkL..",
  "..kqqqqqqqqqAAqqkL..",
  "...kqqqqqqqqqqqk.L..",
  "...kqqqqqqqqqqqkL...",
  "....kqqqqqqqqqk.L...",
  ".....kkqqqqqkkL.....",
  ".......kkkkkLL......",
  ".........LL.........",
  ".........LL.........",
  "......LLLLLLLL......",
  ".....KKKKKKKKKK.....",
]);

const RACK = onCounter([
  "....KKKKKKKKKKKK....",
  "....KXXXXXXXXXXK....",
  "....KXAXAAAqXXXK....",
  "....KXXXqqAXqXXK....",
  "....KXAXAAqXXXXK....",
  "....KXXXqXXXXXXK....",
  "....KXAXqqAAqXXK....",
  "....KXXXXXXXXXXK....",
  "....KXAXAqXXXXXK....",
  "....KXXXXXXXXXXK....",
  "....KXAAXXXXXXXK....",
  "....KXXXXXXXXXXK....",
  "....KKKKKKKKKKKK....",
  "....KkkkkkkkkkqK....",
  "....KkLLLLLLLLkK....",
  "....KkkkkkkkkkkK....",
  "....KkLLLLLLLLkK....",
  "....kkkkkkkkkkkk....",
]);

const KIOSK = onCounter([
  "...KKKKKKKKKKKKKK...",
  "...KXXXXXXXXXXXXK...",
  "...KXXXXXXXXXAAXK...",
  "...KXXXXXXXXAAXXK...",
  "...KXXXXXXXAAXXXK...",
  "...KXAAXXXAAXXXXK...",
  "...KXXAAXAAXXXXXK...",
  "...KXXXAAAXXXXXXK...",
  "...KXXXXAXXXXXXXK...",
  "...KXXXXXXXXXXXXK...",
  "...KXqqqqqqqqqqXK...",
  "...KXXXXXXXXXXXXK...",
  "...KKKKKKKKKKKKKK...",
  "...kkkkkkkkkkkkkk...",
  ".........KK.........",
  ".........KK.........",
  ".......LLLLLL.......",
  "......KKKKKKKK......",
]);

const CRATE = onCounter([
  "....................",
  "....................",
  "..............A.....",
  "..............A.....",
  "..............W.....",
  "......KKKKKKK.W.....",
  "......K.....K.W.....",
  "......K.....K.W.....",
  "..KKKKKKKKKKKKKKKK..",
  "..LLLLLLLLLLLLLLLL..",
  "..KkkkkkkAAkkkkkkK..",
  "..KkkkkkkkkkkkkkkK..",
  "..KLLLLLLLLLLLLLLK..",
  "..KkkkkkkAAkkkkkkK..",
  "..KkkkkkkkkkkkkkkK..",
  "..KLLLLLLLLLLLLLLK..",
  "..KkkkkkkAAkkkkkkK..",
  "..kkkkkkkkkkkkkkkk..",
]);

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
  /** Status LED pixels (relative to sprite top-left) that light up while in use. */
  leds: Array<{ x: number; y: number }>;
  /** Hangs on the back wall; drawn in the shared station kit like the counter devices. */
  onWall?: boolean;
  /** Stands on the shared counter along the back wall (drawn by FurnitureLayer). */
  counter?: boolean;
};

// Back-wall geometry (art px). The counter's base is at COUNTER_BOTTOM; each
// station's name plate hangs just below it (the scene puts the label text
// LABEL_GAP below the furniture bottom, sized in screen px).
export const COUNTER_BOTTOM = 68;
/** The wall board hangs a little higher so its plate sits on the wall, clear of the person in front. */
const BOARD_BOTTOM = 42;
/** Scene: label text top = furniture bottom + LABEL_GAP (art px). */
export const LABEL_GAP = 3;
/** Rendered height of a station name plate in screen px (12px label + padding). */
export const STATION_PLATE_PX = 21;
/**
 * Feet line for everyone working at a back-wall station: right at the counter
 * base, back to the camera, facing the device on the counter (body covers the
 * counter front, head just below the device). Nothing of the person reaches
 * the plate row below (plates start at COUNTER_BOTTOM + LABEL_GAP - padding).
 */
export const STAND_Y = COUNTER_BOTTOM + 2;

/**
 * Extra people at one back-wall station line up along the counter instead of
 * stepping down into the walkway (where they'd cover the plates and the
 * department signs): same feet line, alternating left / right of the device.
 */
export const COUNTER_SPOT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [-12, 0], [12, 0], [-23, 0], [23, 0], [-6, 0], [6, 0], [-17, 0], [17, 0], [-29, 0], [29, 0],
];

/** True for the stations people line up at along the back wall (counter devices + the wall board). */
export function isWallStation(def: Pick<FurnitureDef, "counter" | "onWall">): boolean {
  return Boolean(def.counter || def.onWall);
}

/**
 * Stand spot for the `rank`-th person (0 = first) currently working at a
 * back-wall station. `rank` should count people at THIS station, not the
 * worker's global index, so a lone worker always stands centred at the device.
 */
export function wallStandSpot(def: Pick<FurnitureDef, "standX" | "standY">, rank: number): { x: number; y: number } {
  const [ox, oy] = COUNTER_SPOT_OFFSETS[((rank % COUNTER_SPOT_OFFSETS.length) + COUNTER_SPOT_OFFSETS.length) % COUNTER_SPOT_OFFSETS.length];
  return { x: def.standX + ox, y: def.standY + oy };
}

export const FURNITURE_DEFS: FurnitureDef[] = [
  { key: "board", label: t("任務板"), map: BOARD, x: 32, bottom: BOARD_BOTTOM, standX: 32, standY: STAND_Y, leds: [{ x: 9, y: 2 }, { x: 14, y: 2 }], onWall: true },
  { key: "books", label: t("讀檔案"), map: SHELF, x: 84, bottom: COUNTER_BOTTOM, standX: 84, standY: STAND_Y, leds: [{ x: 17, y: 9 }], counter: true },
  { key: "code", label: t("寫程式"), map: CODE_DESK, x: 134, bottom: COUNTER_BOTTOM, standX: 134, standY: STAND_Y, leds: [{ x: 15, y: 12 }], counter: true },
  { key: "web", label: t("上網查"), map: GLOBE, x: 190, bottom: COUNTER_BOTTOM, standX: 190, standY: STAND_Y, leds: [{ x: 12, y: 16 }], counter: true },
  { key: "terminal", label: t("終端機"), map: RACK, x: 244, bottom: COUNTER_BOTTOM, standX: 244, standY: STAND_Y, leds: [{ x: 14, y: 13 }], counter: true },
  { key: "check", label: t("驗證"), map: KIOSK, x: 298, bottom: COUNTER_BOTTOM, standX: 298, standY: STAND_Y, leds: [{ x: 15, y: 13 }], counter: true },
  { key: "desk", label: t("其他工具"), map: CRATE, x: 352, bottom: COUNTER_BOTTOM, standX: 352, standY: STAND_Y, leds: [{ x: 16, y: 11 }], counter: true },
  // Invisible rendezvous point around the meeting table drawn by OfficeDecor.
  // 作戰室會議桌：桌子本體由 OfficeDecor 畫（在最底部空地），這裡放一塊「透明的點擊區」
  // 蓋在桌面上，讓它跟其他工作站一樣可以懸停看說明、點擊互動（點桌子＝開作戰室模式）。
  // map 全是透明點：pixi 的點擊判定用貼圖邊界矩形、不看像素透明度，所以照樣可點。
  { key: "meeting", label: t("作戰室"), map: Array.from({ length: 34 }, () => ".".repeat(112)), x: 120, bottom: 318, standX: 120, standY: 320, leds: [] },
  // Home positioning and visuals are supplied by PersonalDeskLayer per Worker.
  { key: "home", label: "", map: ["."], x: 200, bottom: 220, standX: 200, standY: 232, leds: [] },
];

export type ScreenBox = { left: number; top: number; right: number; bottom: number };

/**
 * Screen-space boxes of the back-wall station name plates, from the scene's
 * furniture positions (`y` = station mid-height, as reported by the scene).
 * Width is estimated from the label (12px CJK + 1px letter spacing, plate
 * padding 15 left / 7 right) — close enough for keeping DOM tags off them.
 */
export function stationPlateBoxes(positions: Iterable<{ key: StationKey; x: number; y: number }>, scale: number): ScreenBox[] {
  const boxes: ScreenBox[] = [];
  for (const pos of positions) {
    const def = FURNITURE_DEFS.find((d) => d.key === pos.key);
    if (!def || !def.label || !isWallStation(def)) continue;
    const textW = [...def.label].length * 13;
    const top = pos.y + (def.map.length / 2 + LABEL_GAP) * scale - 2;
    boxes.push({ left: pos.x - textW / 2 - 15, right: pos.x + textW / 2 + 7, top, bottom: top + STATION_PLATE_PX });
  }
  return boxes;
}

/**
 * A worker's name tag hangs just below their feet; for someone standing at the
 * counter that lands on the station's plate. Push such a tag down so it starts
 * just below the plate instead of covering it. Returns the (possibly moved) top.
 */
export function tagTopClearOfPlates(x: number, top: number, width: number, height: number, plates: readonly ScreenBox[]): number {
  for (const p of plates) {
    const overlapsX = x + width / 2 > p.left && x - width / 2 < p.right;
    const overlapsY = top < p.bottom && top + height > p.top;
    if (overlapsX && overlapsY) return Math.max(top, p.bottom + 2);
  }
  return top;
}
