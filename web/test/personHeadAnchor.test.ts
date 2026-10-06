import assert from "node:assert/strict";
import test from "node:test";
import { AVATAR_PRESETS } from "../src/game/avatarPresets";
import { buildPresetFrames, frameHeadDrop, headAnchorY } from "../src/game/person";

// Stand-in for a texture: keeps the exact pixel rows the sprite would show.
type FakeFrame = { rows: string[] };

/** Every frame in the preset's frame set, flattened with a readable name ("sideWalk[2]"). */
function framesOf(presetId: string): Array<[string, FakeFrame]> {
  const set = buildPresetFrames<FakeFrame>(presetId, (rows) => ({ rows }));
  return Object.entries(set).flatMap(([key, value]) =>
    Array.isArray(value) ? value.map((frame, i) => [`${key}[${i}]`, frame] as [string, FakeFrame]) : [[key, value] as [string, FakeFrame]]);
}

/** The head's top as actually painted: the first row holding any hair pixel. Measured independently of person.ts. */
function paintedHeadRow(rows: string[]): number {
  for (let y = 0; y < rows.length; y++) if ([...rows[y]].some((px) => px === "H" || px === "h")) return y;
  return -1;
}

/** Where the head's top lands on screen for a sprite anchored at its feet (0), moved by bodyY and squashed by sy. */
function paintedHeadY(rows: string[], bodyY: number, sy: number): number {
  return bodyY - (rows.length - paintedHeadRow(rows)) * sy;
}

const BASE_HEAD_Y = -16; // where head-worn art is drawn for the base idle pose, before the anchor offset

for (const { id } of AVATAR_PRESETS) {
  test(`head anchor follows the painted head on every frame (${id})`, () => {
    const frames = framesOf(id);
    assert.ok(frames.length >= 45, `expected the full frame set, got ${frames.length}`);
    const misses: string[] = [];
    for (const [name, frame] of frames) {
      assert.equal(frame.rows.length, 16, `${name}: frames are 16 rows`);
      assert.notEqual(paintedHeadRow(frame.rows), -1, `${name}: no hair painted`);
      const drop = frameHeadDrop(frame);
      if (drop === undefined) {
        misses.push(`${name}: no head-drop record`);
        continue;
      }
      // Resting, mid-bob, heel-strike squash, crouch, airborne hop — the anchor must land on the hair, 0 px off.
      for (const [bodyY, sy] of [[0, 1], [-1, 1], [1, 1], [0, 0.96], [-1, 0.9], [0, 0.94], [-2.37, 1.03]]) {
        const anchored = BASE_HEAD_Y + headAnchorY(drop, bodyY, sy);
        const painted = paintedHeadY(frame.rows, bodyY, sy);
        const off = anchored - painted;
        if (Math.abs(off) > 1e-9) misses.push(`${name} (bodyY ${bodyY}, sy ${sy}): head anchor off by ${off.toFixed(3)} px`);
      }
    }
    assert.deepEqual(misses, [], `${id}: ${misses.length} misaligned\n${misses.join("\n")}`);
  });
}

test("frames that skip the builder have no head-drop record", () => {
  assert.equal(frameHeadDrop({ rows: [] }), undefined);
});

test("the breathing dip frame sinks the head by one row", () => {
  const set = buildPresetFrames<FakeFrame>("classic", (rows) => ({ rows }));
  assert.equal(frameHeadDrop(set.idleFrames[0]), 0);
  assert.equal(frameHeadDrop(set.idleFrames[1]), 1);
  assert.equal(frameHeadDrop(set.idleBlink[1]), 1);
  assert.equal(frameHeadDrop(set.lookLeft[1]), 1);
});
