import assert from "node:assert/strict";
import test from "node:test";
import { chooseBubblePlacement, type BubbleRect } from "../src/game/bubbleLayout";

test("keeps a speech bubble inside the office viewport", () => {
  const placed = chooseBubblePlacement(2, 28, 120, 32, 500, 300, []);
  assert.ok(placed.rect.left >= 0);
  assert.ok(placed.rect.top >= 0);
  assert.ok(placed.rect.right <= 500);
  assert.ok(placed.rect.bottom <= 300);
});

test("moves a later speech bubble away from an occupied active bubble", () => {
  const occupied: BubbleRect[] = [{ left: 140, top: 90, right: 260, bottom: 130 }];
  const placed = chooseBubblePlacement(200, 130, 120, 40, 500, 300, occupied);
  const overlaps = !(
    placed.rect.right + 6 <= occupied[0].left ||
    placed.rect.left >= occupied[0].right + 6 ||
    placed.rect.bottom + 6 <= occupied[0].top ||
    placed.rect.top >= occupied[0].bottom + 6
  );
  assert.equal(overlaps, false);
  assert.notEqual(placed.bottom, 130);
});
