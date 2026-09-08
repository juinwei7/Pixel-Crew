import assert from "node:assert/strict";
import test from "node:test";
import { isCompositionKey } from "../src/keyboardInput";

test("IME confirmation and cancellation stay with the input method", () => {
  assert.equal(isCompositionKey({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isCompositionKey({ isComposing: true, keyCode: 27 }), true);
  assert.equal(isCompositionKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isCompositionKey({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isCompositionKey({ isComposing: false, keyCode: 27 }), false);
});
