import assert from "node:assert/strict";
import test from "node:test";
import { composerEnterAction } from "../src/commandInteraction";

test("never submits palette text while command choices are loading or empty", () => {
  assert.equal(composerEnterAction(true, true, 4, false), "ignore");
  assert.equal(composerEnterAction(true, false, 0, false), "ignore");
  assert.equal(composerEnterAction(true, false, 2, false), "choose");
});

test("submits only a normal closed-palette Enter", () => {
  assert.equal(composerEnterAction(false, false, 0, false), "submit");
  assert.equal(composerEnterAction(false, false, 0, true), "ignore");
});
