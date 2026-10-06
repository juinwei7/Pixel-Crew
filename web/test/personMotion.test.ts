import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_FIGURE_H,
  AVATAR_FIGURE_MAX_W,
  BREATH_DIP_MS,
  BREATH_MS,
  WALK_EASE_IN_MS,
  WALK_EASE_OUT_PX,
  breathFrame,
  fitAvatar,
  opaqueBounds,
  unionBox,
  walkEase,
} from "../src/game/person";

test("walk eases in from a standstill and out into the spot, never stalling", () => {
  assert.ok(walkEase(0, 100) < 0.5, "first step is slow");
  assert.equal(walkEase(WALK_EASE_IN_MS, 100), 1, "full speed once under way");
  assert.ok(walkEase(WALK_EASE_IN_MS / 2, 100) > walkEase(0, 100), "speeds up");
  assert.ok(walkEase(WALK_EASE_IN_MS, 1) < walkEase(WALK_EASE_IN_MS, WALK_EASE_OUT_PX), "slows down near the end");
  assert.ok(walkEase(0, 0) > 0.3, "never stops short of the spot");
});

test("resting breath is slow and per-NPC, with the dip shorter than the inhale", () => {
  assert.ok(BREATH_MS >= 3_000);
  let dip = 0;
  for (let t = 0; t < BREATH_MS; t += 10) dip += breathFrame(t, 0);
  assert.equal(dip * 10, BREATH_DIP_MS);
  assert.ok(BREATH_DIP_MS < BREATH_MS / 2);
  // Different seeds put neighbours out of step.
  const a = Array.from({ length: 40 }, (_, i) => breathFrame(i * 100, 0.1)).join("");
  const b = Array.from({ length: 40 }, (_, i) => breathFrame(i * 100, 0.6)).join("");
  assert.notEqual(a, b);
});

function rgba(w: number, h: number, opaque: (x: number, y: number) => boolean): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (opaque(x, y)) data[(y * w + x) * 4 + 3] = 255;
  return data;
}

test("opaqueBounds finds the visible figure inside transparent padding", () => {
  const data = rgba(10, 20, (x, y) => x >= 3 && x <= 6 && y >= 5 && y <= 14);
  assert.deepEqual(opaqueBounds(data, 10, 20), { x: 0.3, y: 0.25, w: 0.4, h: 0.5 });
  assert.equal(opaqueBounds(rgba(4, 4, () => false), 4, 4), null);
});

test("uploaded avatars stand at the crew's height regardless of transparent margins", () => {
  // A 256 px square with the figure in the middle half: used to come out ~6 px tall.
  const padded = fitAvatar(256, 256, { x: 0.3, y: 0.2, w: 0.4, h: 0.6 });
  assert.ok(Math.abs(padded.scale * 256 * 0.6 - AVATAR_FIGURE_H) < 1e-9);
  assert.ok(padded.scale * 256 * 0.4 <= AVATAR_FIGURE_MAX_W + 1e-9);
  // Anchored on the figure's feet, centred.
  assert.ok(Math.abs(padded.ax - 0.5) < 1e-9);
  assert.ok(Math.abs(padded.ay - 0.8) < 1e-9);
  // A wide figure is limited by width instead.
  const wide = fitAvatar(200, 50, null);
  assert.ok(Math.abs(wide.scale * 200 - AVATAR_FIGURE_MAX_W) < 1e-9);
  assert.equal(wide.ax, 0.5);
  assert.equal(wide.ay, 1);
});

test("unionBox covers both frames", () => {
  assert.deepEqual(unionBox({ x: 0.1, y: 0.2, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.1, w: 0.1, h: 0.1 }), { x: 0.1, y: 0.1, w: 0.5, h: 0.30000000000000004 });
  assert.deepEqual(unionBox(null, { x: 0, y: 0, w: 1, h: 1 }), { x: 0, y: 0, w: 1, h: 1 });
});
