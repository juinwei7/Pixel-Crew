// Pixel Crew's app icon artwork.
//
// The mark is the crew itself: the same front-facing NPC sprite the PixiJS
// office draws (web/src/game/person.ts), three of them standing in the room.
// Everything here is pure data plus pure functions so the generator and its
// tests can build the icon without touching a filesystem or a rasteriser.

export const PALETTE = {
  ".": null,
  H: 0x4a3a6b, // back crew member — hair
  I: 0x8a5a3c, // front-left — hair
  J: 0x2f3d5c, // front-right — hair
  S: 0xf2c9a0, // back — skin
  T: 0xd8a273, // front-left — skin
  U: 0xa9713f, // front-right — skin
  E: 0x22182e, // eyes
  B: 0x4ad2f0, // back — shirt (the brand cyan)
  G: 0x37d6a3, // front-left — shirt
  A: 0xf2b45c, // front-right — shirt
  P: 0x3f5180, // back — trousers
  Q: 0x33425f, // front pair — trousers
  F: 0x1b2540, // shoes
};

// web/src/game/person.ts FRONT_IDLE_0, minus the in-game sleeve shading: two
// stray darker pixels read as buttons once the sprite is blown up to 1024px.
const NPC = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHHHHHHH..",
  "..HSSSSSSH..",
  "..HSESSESH..",
  "..HSSSSSSH..",
  "...SSSSSS...",
  "..BBBBBBBB..",
  ".SBBBBBBBBS.",
  ".SBBBBBBBBS.",
  "..BBBBBBBB..",
  "..PPPPPPPP..",
  "..PPP..PPP..",
  "..PPP..PPP..",
  "..FFF..FFF..",
];

// Three sprites cannot survive a 16px favicon, so small sizes show one crew
// member with the legs shortened by a row — same character, drawn to fit.
const NPC_COMPACT = [
  "..HHHHHH..",
  ".HHHHHHHH.",
  ".HSSSSSSH.",
  ".HSESSESH.",
  ".HSSSSSSH.",
  "..SSSSSS..",
  ".BBBBBBBB.",
  "SBBBBBBBBS",
  "SBBBBBBBBS",
  ".PPPPPPPP.",
  ".PP....PP.",
  ".FF....FF.",
];

const blank = (width, height) =>
  Array.from({ length: height }, () => ".".repeat(width).split(""));

function paint(grid, sprite, originX, originY, recolour = {}) {
  sprite.forEach((row, y) => [...row].forEach((pixel, x) => {
    if (pixel === ".") return;
    const gy = originY + y;
    const gx = originX + x;
    if (gy < 0 || gy >= grid.length || gx < 0 || gx >= grid[0].length) return;
    grid[gy][gx] = recolour[pixel] ?? pixel;
  }));
}

// One crew member a step back and two in front: the triangle keeps the group
// roughly as tall as it is wide, which a square icon needs.
function crewRows() {
  const grid = blank(32, 20);
  paint(grid, NPC, 10, 0);
  paint(grid, NPC, 2, 5, { H: "I", S: "T", B: "G", P: "Q" });
  paint(grid, NPC, 18, 5, { H: "J", S: "U", B: "A", P: "Q" });
  return grid.map((row) => row.join(""));
}

/** Shadow ellipses are in sprite-grid units so they scale with the artwork. */
export const CREW = {
  rows: crewRows(),
  shadows: [
    { x: 8, y: 20, rx: 5.5, ry: 1.6, strength: 0.68 },
    { x: 24, y: 20, rx: 5.5, ry: 1.6, strength: 0.68 },
    { x: 16, y: 15, rx: 5, ry: 1.4, strength: 0.5 },
  ],
};

/** Below 128px a contact shadow is just a smudge, so the compact mark has none. */
export const COMPACT = { rows: NPC_COMPACT, shadows: [] };

/**
 * Every size the icon is rendered at, with the whole-number sprite scale it
 * uses. Pixel art only stays crisp at integer scales, so this is a table
 * rather than a ratio — every entry works out to the sprite's longest side
 * filling exactly 75% of the canvas, which leaves the margin macOS and
 * Windows both expect.
 */
export const SIZES = [
  { size: 16, art: COMPACT, scale: 1 },
  { size: 32, art: COMPACT, scale: 2 },
  { size: 48, art: COMPACT, scale: 3 },
  { size: 64, art: COMPACT, scale: 4 },
  { size: 128, art: CREW, scale: 3 },
  { size: 256, art: CREW, scale: 6 },
  { size: 512, art: CREW, scale: 12 },
  { size: 1024, art: CREW, scale: 24 },
];

export function layoutFor(size) {
  const layout = SIZES.find((entry) => entry.size === size);
  if (!layout) throw new Error(`No icon layout is defined for ${size}px`);
  const { rows, shadows } = layout.art;
  const width = rows[0].length * layout.scale;
  const height = rows.length * layout.scale;
  return {
    size,
    rows,
    shadows,
    scale: layout.scale,
    width,
    height,
    offsetX: Math.round((size - width) / 2),
    offsetY: Math.round((size - height) / 2),
  };
}
