import assert from "node:assert/strict";
import test from "node:test";
import { computeDropIndex, moveId, reorderShift } from "../src/crewReorder";

test("computeDropIndex maps a pointer y to an insertion slot", () => {
  const midYs = [10, 30, 50];
  assert.equal(computeDropIndex(midYs, 0), 0);
  assert.equal(computeDropIndex(midYs, 20), 1);
  assert.equal(computeDropIndex(midYs, 40), 2);
  assert.equal(computeDropIndex(midYs, 99), 3);
  assert.equal(computeDropIndex([], 42), 0);
});

test("moveId moves an id up, down, and to both ends", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveId(ids, "c", 1), ["a", "c", "b", "d"]);
  assert.deepEqual(moveId(ids, "b", 4), ["a", "c", "d", "b"]);
  assert.deepEqual(moveId(ids, "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveId(ids, "a", 3), ["b", "c", "a", "d"]);
});

test("moveId returns the original array on a no-op drop", () => {
  const ids = ["a", "b", "c"];
  // Dropping right before or right after itself changes nothing.
  assert.equal(moveId(ids, "b", 1), ids);
  assert.equal(moveId(ids, "b", 2), ids);
  assert.equal(moveId(ids, "missing", 0), ids);
});

test("reorderShift parts neighbours and glides the dragged row into the gap", () => {
  const shifts = (from: number, insert: number) =>
    [0, 1, 2, 3, 4].map((index) => reorderShift(index, from, insert, 10));
  // Dragging row 1 two slots down (before original index 4): rows 2-3 open the gap.
  assert.deepEqual(shifts(1, 4), [0, 20, -10, -10, 0]);
  // Dragging row 3 to the top: rows 0-2 move down, dragged row glides up.
  assert.deepEqual(shifts(3, 0), [10, 10, 10, -30, 0]);
  // Dropping right around itself is a no-op.
  assert.deepEqual(shifts(2, 2), [0, 0, 0, 0, 0]);
  assert.deepEqual(shifts(2, 3), [0, 0, 0, 0, 0]);
  // Unknown drag source shifts nothing.
  assert.deepEqual(shifts(-1, 2), [0, 0, 0, 0, 0]);
});

test("moveId clamps out-of-range insertion indexes", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(moveId(ids, "c", -5), ["c", "a", "b"]);
  assert.deepEqual(moveId(ids, "a", 99), ["b", "c", "a"]);
});
