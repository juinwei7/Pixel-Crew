// Station furniture: pixel maps, positions and labels. Plain data (no Pixi)
// so the app entry can place station tooltips before the office scene loads.
import type { StationKey } from "../stations";
import { t } from "../i18n";

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
  { key: "board", label: t("任務板"), map: BOARD, x: 32, bottom: 48, standX: 32, standY: 72, leds: [{ x: 3, y: 2 }, { x: 15, y: 3 }] },
  { key: "books", label: t("讀檔案"), map: SHELF, x: 84, bottom: 68, standX: 84, standY: 82, leds: [{ x: 3, y: 2 }, { x: 12, y: 6 }] },
  { key: "code", label: t("寫程式"), map: CODE_DESK, x: 136, bottom: 68, standX: 136, standY: 82, leds: [{ x: 8, y: 2 }, { x: 12, y: 4 }] },
  { key: "web", label: t("上網查"), map: GLOBE, x: 190, bottom: 68, standX: 190, standY: 82, leds: [{ x: 8, y: 3 }, { x: 6, y: 5 }] },
  { key: "terminal", label: t("終端機"), map: RACK, x: 244, bottom: 68, standX: 244, standY: 83, leds: [{ x: 2, y: 2 }, { x: 3, y: 4 }, { x: 2, y: 6 }] },
  { key: "check", label: t("驗證"), map: KIOSK, x: 298, bottom: 68, standX: 298, standY: 83, leds: [{ x: 3, y: 3 }, { x: 9, y: 3 }] },
  { key: "desk", label: t("其他工具"), map: CRATE, x: 352, bottom: 66, standX: 352, standY: 81, leds: [{ x: 2, y: 2 }, { x: 13, y: 6 }] },
  // Invisible rendezvous point around the meeting table drawn by OfficeDecor.
  // 作戰室會議桌：桌子本體由 OfficeDecor 畫（在最底部空地），這裡放一塊「透明的點擊區」
  // 蓋在桌面上，讓它跟其他工作站一樣可以懸停看說明、點擊互動（點桌子＝開作戰室模式）。
  // map 全是透明點：pixi 的點擊判定用貼圖邊界矩形、不看像素透明度，所以照樣可點。
  { key: "meeting", label: t("作戰室"), map: Array.from({ length: 34 }, () => ".".repeat(112)), x: 120, bottom: 318, standX: 120, standY: 320, leds: [] },
  // Home positioning and visuals are supplied by PersonalDeskLayer per Worker.
  { key: "home", label: "", map: ["."], x: 200, bottom: 220, standX: 200, standY: 232, leds: [] },
];
