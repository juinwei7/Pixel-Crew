import assert from "node:assert/strict";
import test from "node:test";
import { responsiveOfficeFitScale } from "../src/game/camera";

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
