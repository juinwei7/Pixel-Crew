import { t } from "../i18n";

// Pure logic behind the little things on the office floor — personal-desk
// trinkets, the night desk lamp, queued-command sticky notes, the waste-paper
// bin and the whiteboard tally. No Pixi here, so it is cheap to unit-test;
// personalDesks.ts / room.ts only draw what these functions decide.

/** A pixel rect in local art px: [x, y, w, h]. */
export type PxRect = [number, number, number, number];

// ---------------------------------------------------------------- trinkets

export const TRINKETS = ["cactus", "mug", "photo", "duck", "succulent", "books", "cube", "robot"] as const;
export type Trinket = (typeof TRINKETS)[number];

/** Stable per-NPC pick: the same id always gets the same desk trinket. */
export function trinketFor(id: string): Trinket {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return TRINKETS[hash % TRINKETS.length];
}

/**
 * Trinket pixels, drawn on the right of the desk top (desk surface is y = -5,
 * monitor ends at x = 7). Colours are deliberately muted so they never compete
 * with the nameplates.
 */
export function trinketPixels(kind: Trinket): Array<[number, number, number, number, number]> {
  switch (kind) {
    case "cactus":
      return [[10, -7, 3, 2, 0x5c4436], [11, -11, 1, 4, 0x3d6b52], [12, -10, 1, 1, 0x3d6b52], [10, -9, 1, 1, 0x3d6b52]];
    case "mug":
      return [[10, -8, 3, 3, 0x6e5656], [13, -7, 1, 1, 0x6e5656], [10, -8, 3, 1, 0x806666]];
    case "photo":
      return [[10, -10, 3, 4, 0x5a4a3a], [11, -9, 1, 2, 0x41607e]];
    case "duck":
      return [[10, -7, 3, 2, 0x8c7c3c], [11, -9, 2, 2, 0x8c7c3c], [13, -8, 1, 1, 0x8a5f36]];
    case "succulent":
      return [[10, -7, 3, 2, 0x524466], [10, -9, 1, 2, 0x3a6448], [12, -9, 1, 2, 0x3a6448], [11, -10, 1, 3, 0x447556]];
    case "books":
      return [[9, -6, 5, 1, 0x54476e], [10, -7, 4, 1, 0x42605e], [9, -8, 4, 1, 0x6b5040]];
    case "cube":
      return [[10, -8, 3, 3, 0x6b4646], [11, -7, 1, 1, 0x41607e], [12, -8, 1, 1, 0x7a7040]];
    case "robot":
      return [[10, -9, 3, 3, 0x56657a], [11, -10, 1, 1, 0x56657a], [10, -8, 1, 1, 0x3a8a8a], [12, -8, 1, 1, 0x3a8a8a]];
  }
}

// ---------------------------------------------------------------- desk lamp

/** After a worker goes idle the lamp stays on this long, then switches off. */
export const LAMP_LINGER_MS = 10 * 60_000;

/**
 * Night lamp: lit only at night, always while working, and for a while after
 * the last job — an NPC that has been idle long sits in the dark. `lastBusyAt`
 * is null when we have never seen this worker busy (e.g. right after a reload).
 */
export function lampLit(night: boolean, busy: boolean, lastBusyAt: number | null, nowMs: number): boolean {
  if (!night) return false;
  if (busy) return true;
  return lastBusyAt !== null && nowMs - lastBusyAt < LAMP_LINGER_MS;
}

// ---------------------------------------------------------------- sticky notes

/** Notes stuck on the monitor's right bezel; the third becomes a pad when the queue is longer. */
export const MAX_NOTES = 3;

export type NoteLayout = { notes: PxRect[]; stacked: boolean };

export function noteLayout(queueCount: number): NoteLayout {
  const n = Math.max(0, Math.min(MAX_NOTES, Math.floor(queueCount)));
  const notes: PxRect[] = [];
  for (let i = 0; i < n; i++) notes.push([6, -18 + i * 3, 3, 2]);
  return { notes, stacked: queueCount > MAX_NOTES };
}

/** Generous tap box around the notes (they are only 3x2 art px each). */
export const NOTE_HIT: PxRect = [4, -20, 7, 12];

export function noteHit(x: number, y: number, queueCount: number): boolean {
  if (queueCount <= 0) return false;
  const [hx, hy, hw, hh] = NOTE_HIT;
  return x >= hx && x < hx + hw && y >= hy && y < hy + hh;
}

export type QueueCard = { title: string; lines: string[]; more: string | null };

/** What the floating card shows: the first three queued commands, one line each. */
export function queueCard(items: readonly string[], maxChars = 40): QueueCard {
  const lines = items.slice(0, MAX_NOTES).map((raw) => {
    const line = raw.replace(/\s+/g, " ").trim();
    return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
  });
  const rest = items.length - lines.length;
  return {
    title: t("排隊中的指令 · {count}", { count: items.length }),
    lines,
    more: rest > 0 ? t("還有 {count} 筆", { count: rest }) : null,
  };
}

// ---------------------------------------------------------------- waste-paper bin

/** Paper balls fill the bin bottom-up; the fifth sits heaped at the rim. */
export const MAX_PAPER_BALLS = 5;
const BALL_SLOTS: PxRect[] = [[15, 4, 2, 2], [17, 4, 2, 2], [15, 2, 2, 2], [17, 2, 2, 2], [16, 0, 2, 2]];

export function paperBalls(failures: number): PxRect[] {
  return BALL_SLOTS.slice(0, Math.max(0, Math.min(MAX_PAPER_BALLS, Math.floor(failures))));
}

// ---------------------------------------------------------------- whiteboard tally (正)

/** Strokes of one 正 in the order it is written, relative to its top-left (5x5). */
export const ZHENG_STROKES: PxRect[] = [
  [0, 0, 5, 1], // 一 top
  [2, 1, 1, 3], // 丨 middle
  [3, 2, 2, 1], // 一 short right
  [0, 2, 1, 2], // 丨 short left
  [0, 4, 5, 1], // 一 bottom
];
/** Up to this many full 正 are written out; beyond that the board switches to 正×N. */
export const MAX_ZHENG = 5;
const GLYPH_PITCH = 6;

/** 3x5 pixel digits, rows top→bottom as 3-bit masks. */
const DIGITS: number[][] = [
  [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 1, 2, 2], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
];

function digitRects(d: number, ox: number, oy: number): PxRect[] {
  const out: PxRect[] = [];
  DIGITS[d].forEach((mask, row) => {
    for (let col = 0; col < 3; col++) if (mask & (4 >> col)) out.push([ox + col, oy + row, 1, 1]);
  });
  return out;
}

/**
 * Pixel strokes for today's tally, in write order (so the board can draw them
 * one by one). Up to 25: one stroke per completion, five per 正. Past that it
 * reads 正×N (N = full 正) plus the strokes of the 正 in progress.
 */
export function tallyStrokes(count: number, ox: number, oy: number): PxRect[] {
  const n = Math.max(0, Math.floor(count));
  const out: PxRect[] = [];
  const glyph = (strokes: number, gx: number) => {
    for (let i = 0; i < strokes; i++) {
      const [x, y, w, h] = ZHENG_STROKES[i];
      out.push([gx + x, oy + y, w, h]);
    }
  };
  if (n <= MAX_ZHENG * 5) {
    for (let k = 0; k * 5 < n; k++) glyph(Math.min(5, n - k * 5), ox + k * GLYPH_PITCH);
    return out;
  }
  const full = Math.min(99, Math.floor(n / 5));
  glyph(5, ox);
  let x = ox + GLYPH_PITCH;
  // ×: a 3x3 cross on the glyph's middle rows.
  out.push([x, oy + 1, 1, 1], [x + 2, oy + 1, 1, 1], [x + 1, oy + 2, 1, 1], [x, oy + 3, 1, 1], [x + 2, oy + 3, 1, 1]);
  x += 4;
  for (const ch of String(full)) {
    out.push(...digitRects(Number(ch), x, oy));
    x += 4;
  }
  const partial = n - full * 5;
  if (partial > 0 && full < 99) glyph(partial, x + 1);
  return out;
}

// ---------------------------------------------------------------- day rollover

/** Local calendar day, e.g. "2026-10-06" — the daily counters clear when it changes. */
export function dayKey(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
