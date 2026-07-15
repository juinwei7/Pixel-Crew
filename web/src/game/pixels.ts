import { Texture } from "pixi.js";

/**
 * Pixel-map → Texture. Each string is a row, each char a pixel keyed
 * into the palette. '.' (or missing key) = transparent.
 */
export type Palette = Record<string, number | undefined>;

export function texFromMap(rows: string[], palette: Palette): Texture {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = palette[rows[y][x]];
      if (color === undefined) continue;
      ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** Shared art palette (cyber-office, dark neon). */
export const PAL: Palette = {
  ".": undefined,
  // person
  H: 0x3b2f55, // hair
  h: 0x2c2240, // hair shade
  S: 0xf2c9a0, // skin
  E: 0x22182e, // eyes
  B: 0x3fc9e8, // shirt
  b: 0x2b93ad, // shirt shade
  P: 0x33436e, // pants
  p: 0x263450, // pants shade (back leg)
  F: 0x1d2740, // shoes
  // furniture / props
  W: 0x8fa8cc, // light frame
  w: 0x5c729a, // frame shade
  D: 0x31416b, // furniture body
  d: 0x243252, // furniture shade
  X: 0x101828, // screen / darkest
  C: 0x4de3ff, // neon cyan
  c: 0x2b8ba6, // dim cyan
  G: 0x37d6a3, // green
  M: 0xff4dd8, // magenta
  Y: 0xffd166, // yellow
  R: 0xff5c7a, // red
  O: 0xf29e4c, // orange (books)
  U: 0x7c5cff, // purple
};
