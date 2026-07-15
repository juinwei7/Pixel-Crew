import assert from "node:assert/strict";
import test from "node:test";
import { quantizePixels, removeCornerBackground } from "../src/avatar/normalizeAvatar";

test("removes a flat corner background while keeping a distinct subject", () => {
  const pixels = new Uint8ClampedArray([
    240, 240, 240, 255, 240, 240, 240, 255, 240, 240, 240, 255,
    240, 240, 240, 255, 20, 40, 80, 255, 240, 240, 240, 255,
    240, 240, 240, 255, 240, 240, 240, 255, 240, 240, 240, 255,
  ]);
  removeCornerBackground(pixels, 3, 3, 20);
  assert.equal(pixels[3], 0);
  assert.equal(pixels[(4 * 4) + 3], 255);
  assert.deepEqual([...pixels.slice(16, 19)], [20, 40, 80]);
});

test("reduces opaque pixels to the requested deterministic palette", () => {
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    250, 5, 0, 255,
    0, 0, 255, 255,
    5, 0, 250, 255,
    0, 255, 0, 0,
  ]);
  quantizePixels(pixels, 2);
  const colors = new Set<string>();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3]) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
  }
  assert.equal(colors.size, 2);
  assert.equal(pixels[19], 0);
});
