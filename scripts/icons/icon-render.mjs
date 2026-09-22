// Rasteriser for the Pixel Crew icon: an anti-aliased squircle room with the
// crew sprite stamped on top at a whole-number scale. No image library is
// involved — the icon is small enough to draw pixel by pixel, which keeps the
// release packagers dependency-free on every platform.

import { PALETTE, layoutFor } from "./icon-art.mjs";

const SUPERSAMPLE = 4;
const SQUIRCLE_EXPONENT = 4.3; // ~the macOS app-icon silhouette
const WALL_TOP = 0x243a6d;
const WALL_BOTTOM = 0x131f3a;
const FLOOR_TOP = 0x24395f;
const FLOOR_BOTTOM = 0x111d36;
const HORIZON = 0.7;
const GLOW = 0x4de3ff;
const GLOW_STRENGTH = 0.3;

/** @returns {{ size: number, buffer: Buffer }} RGBA pixels, 8 bits per channel. */
export function renderIcon(size) {
  const layout = layoutFor(size);
  const image = renderRoom(size, layout.shadows.map((shadow) => ({
    x: layout.offsetX + shadow.x * layout.scale,
    y: layout.offsetY + shadow.y * layout.scale,
    rx: shadow.rx * layout.scale,
    ry: shadow.ry * layout.scale,
    strength: shadow.strength,
  })));
  stampSprite(image, layout);
  return image;
}

function renderRoom(size, shadows) {
  const buffer = Buffer.alloc(size * size * 4, 0);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = squircleCoverage(x, y, half);
      if (!coverage) continue;
      const depth = y / (size - 1);
      let colour = depth < HORIZON
        ? blend(WALL_TOP, WALL_BOTTOM, depth / HORIZON)
        : blend(FLOOR_TOP, FLOOR_BOTTOM, (depth - HORIZON) / (1 - HORIZON));
      const distance = Math.min(1, Math.hypot((x - half) / half, (y - size * 0.42) / half));
      colour = tint(colour, GLOW, GLOW_STRENGTH * (1 - distance) ** 2.4);
      for (const shadow of shadows) {
        const spread = Math.hypot((x + 0.5 - shadow.x) / shadow.rx, (y + 0.5 - shadow.y) / shadow.ry);
        if (spread >= 1) continue;
        const darken = (1 - spread) ** 1.6 * shadow.strength;
        colour = colour.map((channel) => channel * (1 - darken));
      }
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(colour[0]);
      buffer[offset + 1] = Math.round(colour[1]);
      buffer[offset + 2] = Math.round(colour[2]);
      buffer[offset + 3] = Math.round(coverage * 255);
    }
  }
  return { size, buffer };
}

function squircleCoverage(x, y, half) {
  let inside = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const px = (x + (sx + 0.5) / SUPERSAMPLE - half) / half;
      const py = (y + (sy + 0.5) / SUPERSAMPLE - half) / half;
      if (Math.abs(px) ** SQUIRCLE_EXPONENT + Math.abs(py) ** SQUIRCLE_EXPONENT <= 1) inside++;
    }
  }
  return inside / (SUPERSAMPLE * SUPERSAMPLE);
}

function stampSprite(image, { rows, scale, offsetX, offsetY }) {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const colour = PALETTE[rows[y][x]];
      if (colour === null || colour === undefined) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const py = offsetY + y * scale + dy;
          const px = offsetX + x * scale + dx;
          if (py < 0 || py >= image.size || px < 0 || px >= image.size) continue;
          const offset = (py * image.size + px) * 4;
          image.buffer[offset] = (colour >> 16) & 255;
          image.buffer[offset + 1] = (colour >> 8) & 255;
          image.buffer[offset + 2] = colour & 255;
          image.buffer[offset + 3] = 255;
        }
      }
    }
  }
}

function blend(from, to, ratio) {
  return [16, 8, 0].map((shift) => {
    const start = (from >> shift) & 255;
    const end = (to >> shift) & 255;
    return start + (end - start) * ratio;
  });
}

function tint(colour, hex, amount) {
  return colour.map((channel, index) => {
    const target = (hex >> (16 - index * 8)) & 255;
    return channel + (target - channel) * amount;
  });
}

/**
 * The same artwork as scalable markup, for the favicon. Browsers draw SVG
 * favicons at 16–32px, so it uses the compact mark and merges each row of
 * identical pixels into one rect to keep the file small.
 */
export function renderIconSvg() {
  const { rows, scale, offsetX, offsetY } = layoutFor(32);
  const pixels = [];
  for (let y = 0; y < rows.length; y++) {
    let run = null;
    const flush = () => {
      if (!run) return;
      pixels.push(`<rect x="${offsetX + run.start * scale}" y="${offsetY + y * scale}" `
        + `width="${run.length * scale}" height="${scale}" fill="${hex(run.colour)}"/>`);
      run = null;
    };
    for (let x = 0; x < rows[y].length; x++) {
      const colour = PALETTE[rows[y][x]];
      if (colour === null || colour === undefined) { flush(); continue; }
      if (run && run.colour === colour) { run.length += 1; continue; }
      flush();
      run = { colour, start: x, length: 1 };
    }
    flush();
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-labelledby="title desc">
  <title id="title">Pixel Crew</title>
  <desc id="desc">A pixel-art crew member standing in a dark office.</desc>
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(WALL_TOP)}"/><stop offset="1" stop-color="${hex(WALL_BOTTOM)}"/>
    </linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(FLOOR_TOP)}"/><stop offset="1" stop-color="${hex(FLOOR_BOTTOM)}"/>
    </linearGradient>
    <clipPath id="frame"><rect width="32" height="32" rx="8.4"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="32" height="32" fill="url(#wall)"/>
    <rect y="${(32 * HORIZON).toFixed(1)}" width="32" height="${(32 * (1 - HORIZON)).toFixed(1)}" fill="url(#floor)"/>
    <g shape-rendering="crispEdges">${pixels.join("")}</g>
  </g>
</svg>
`;
}

function hex(colour) {
  return `#${colour.toString(16).padStart(6, "0")}`;
}
