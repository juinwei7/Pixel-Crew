import assert from "node:assert/strict";
import test from "node:test";
import { officeMinScale, responsiveOfficeFitScale } from "../src/game/camera";

test("responsive office fit changes continuously with browser width", () => {
  assert.equal(responsiveOfficeFitScale(1_024), 2);
  assert.equal(responsiveOfficeFitScale(1_472), 2.375);
  assert.equal(responsiveOfficeFitScale(1_920), 2.75);
});

test("responsive office fit has comfortable bounds on small and large screens", () => {
  assert.equal(responsiveOfficeFitScale(4_000), 2.75);
  assert.equal(responsiveOfficeFitScale(320), 2);
  assert.equal(responsiveOfficeFitScale(0), 2);
});

test("a normal office keeps the 2x zoom floor; an annex floor may zoom out to 1x", () => {
  assert.equal(officeMinScale(336, 336), 2);
  // 30 NPCs: the annex floor no longer caps zoom-out at its height fit (~1.5x),
  // so the whole crew can clear the side panels.
  assert.equal(officeMinScale(520, 336), 1);
});
