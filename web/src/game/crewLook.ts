// Crew look data shared by the office scene and the regular UI (crew chips,
// avatar workshop). Kept free of Pixi and of the Person sprite class so the
// app entry can use it without pulling the office engine in — the scene
// itself is loaded on demand (see GameCanvas).

/** Front-facing idle frame (12x16 pixel map): the base every avatar preview is painted from. */
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

/** Shirt color variants so each worker NPC is distinguishable. */
export const SHIRT_COLORS: Array<[number, number]> = [
  [0x3fc9e8, 0x2b93ad], // cyan
  [0xff4dd8, 0xb436a0], // magenta
  [0xffd166, 0xc29a3a], // yellow
  [0x37d6a3, 0x27967a], // green
  [0x9b7bff, 0x6f52c9], // purple
  [0xf29e4c, 0xb56f2f], // orange
];
