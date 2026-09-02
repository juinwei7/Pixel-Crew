import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsed } from "../src/formatElapsed";

test("formats shared elapsed time with each surface's minute-padding convention", () => {
  assert.equal(formatElapsed(65), "1:05");
  assert.equal(formatElapsed(65, { padMinutes: true }), "01:05");
  assert.equal(formatElapsed(-10), "0:00");
});
