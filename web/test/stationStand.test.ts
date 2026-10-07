import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COUNTER_BOTTOM,
  COUNTER_SPOT_OFFSETS,
  FURNITURE_DEFS,
  LABEL_GAP,
  STAND_Y,
  isWallStation,
  stationPlateBoxes,
  tagTopClearOfPlates,
  wallStandSpot,
} from "../src/game/furnitureDefs";

const PERSON_H = 16; // back-view sprite rows, anchored at the feet
const wallDefs = FURNITURE_DEFS.filter(isWallStation);
const furnitureSrc = readFileSync(new URL("../src/game/furniture.ts", import.meta.url), "utf8");
const personSrc = readFileSync(new URL("../src/game/person.ts", import.meta.url), "utf8");

test("all six counter stations and the wall board are back-wall stations", () => {
  assert.deepEqual(wallDefs.map((d) => d.key).sort(), ["board", "books", "check", "code", "desk", "terminal", "web"]);
});

test("a worker stands centred at the counter base, in front of the device, not in the plate row", () => {
  for (const def of wallDefs) {
    assert.equal(def.standX, def.x, `${def.key} stand x is centred on the device`);
    assert.equal(def.standY, STAND_Y, `${def.key} shares the counter feet line`);
    // The plate starts LABEL_GAP below the furniture bottom (minus ~1 art px of padding).
    const plateTop = def.bottom + LABEL_GAP - 1;
    assert.ok(def.standY - 1 < plateTop || def.onWall, `${def.key}: feet stay above its plate`);
    // Body covers the counter front: head no higher than the device bottom area, feet at the base.
    if (def.counter) {
      assert.ok(def.standY >= COUNTER_BOTTOM && def.standY <= COUNTER_BOTTOM + 3);
      assert.ok(def.standY - PERSON_H < COUNTER_BOTTOM - 8, "head overlaps the counter front, i.e. right at it");
    }
  }
  const board = wallDefs.find((d) => d.key === "board")!;
  assert.ok(board.standY - PERSON_H >= board.bottom + LABEL_GAP + 8, "the board plate sits above the head of whoever works at it");
});

test("extra people at one station line up along the counter (same feet line, alternating sides)", () => {
  const def = wallDefs.find((d) => d.key === "terminal")!;
  assert.deepEqual(wallStandSpot(def, 0), { x: def.x, y: STAND_Y });
  const xs = Array.from({ length: 5 }, (_, i) => wallStandSpot(def, i).x - def.x);
  assert.deepEqual(xs, [0, -12, 12, -23, 23]);
  for (const [, oy] of COUNTER_SPOT_OFFSETS) assert.equal(oy, 0);
  assert.deepEqual(wallStandSpot(def, COUNTER_SPOT_OFFSETS.length), wallStandSpot(def, 0));
});

test("plate boxes follow the scene's label placement", () => {
  const code = FURNITURE_DEFS.find((d) => d.key === "code")!;
  const s = 2;
  const pos = { key: code.key, x: 500, y: 100 + (code.bottom - code.map.length / 2) * s };
  const [box] = stationPlateBoxes([pos, { key: "home", x: 0, y: 0 }], s);
  assert.equal(box.top, 100 + (code.bottom + LABEL_GAP) * s - 2);
  assert.ok(box.left < 500 && box.right > 500);
});

test("a name tag that would land on a station plate starts just below it; others are untouched", () => {
  const plate = { left: 100, right: 180, top: 200, bottom: 221 };
  assert.equal(tagTopClearOfPlates(140, 210, 120, 18, [plate]), 223);
  assert.equal(tagTopClearOfPlates(140, 240, 120, 18, [plate]), 240, "already below");
  assert.equal(tagTopClearOfPlates(400, 210, 120, 18, [plate]), 210, "beside it");
});

test("hover no longer draws the stale full-sprite outline; counter workers get no personal desk kit", () => {
  assert.doesNotMatch(furnitureSrc, /if \(this\.hovered\) g\.rect\(left - 1/);
  assert.match(furnitureSrc, /HOVER_K/);
  assert.match(personSrc, /BUILT_IN_SCREEN = new Set<StationKey>\(\["terminal", "code", "web", "check", "board", "desk"\]\)/);
});
