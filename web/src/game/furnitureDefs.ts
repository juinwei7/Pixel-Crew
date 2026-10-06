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

export const FURNITURE_DEFS: FurnitureDef[] = [
  { key: "board", label: t("任務板"), map: BOARD, x: 32, bottom: 48, standX: 32, standY: 72, leds: [{ x: 9, y: 2 }, { x: 14, y: 2 }], onWall: true },
  { key: "books", label: t("讀檔案"), map: SHELF, x: 84, bottom: 68, standX: 84, standY: 82, leds: [{ x: 17, y: 9 }], counter: true },
  { key: "code", label: t("寫程式"), map: CODE_DESK, x: 134, bottom: 68, standX: 136, standY: 82, leds: [{ x: 15, y: 12 }], counter: true },
  { key: "web", label: t("上網查"), map: GLOBE, x: 190, bottom: 68, standX: 190, standY: 82, leds: [{ x: 12, y: 16 }], counter: true },
  { key: "terminal", label: t("終端機"), map: RACK, x: 244, bottom: 68, standX: 244, standY: 83, leds: [{ x: 14, y: 13 }], counter: true },
  { key: "check", label: t("驗證"), map: KIOSK, x: 298, bottom: 68, standX: 298, standY: 83, leds: [{ x: 15, y: 13 }], counter: true },
  { key: "desk", label: t("其他工具"), map: CRATE, x: 352, bottom: 68, standX: 352, standY: 81, leds: [{ x: 16, y: 11 }], counter: true },
  // Invisible rendezvous point around the meeting table drawn by OfficeDecor.
  // 作戰室會議桌：桌子本體由 OfficeDecor 畫（在最底部空地），這裡放一塊「透明的點擊區」
  // 蓋在桌面上，讓它跟其他工作站一樣可以懸停看說明、點擊互動（點桌子＝開作戰室模式）。
  // map 全是透明點：pixi 的點擊判定用貼圖邊界矩形、不看像素透明度，所以照樣可點。
  { key: "meeting", label: t("作戰室"), map: Array.from({ length: 34 }, () => ".".repeat(112)), x: 120, bottom: 318, standX: 120, standY: 320, leds: [] },
  // Home positioning and visuals are supplied by PersonalDeskLayer per Worker.
  { key: "home", label: "", map: ["."], x: 200, bottom: 220, standX: 200, standY: 232, leds: [] },
];
