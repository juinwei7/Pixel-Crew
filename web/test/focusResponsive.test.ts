import assert from "node:assert/strict";
import test from "node:test";
import { FOCUS_READER_BREAKPOINTS, focusReaderLayout } from "../src/focusResponsive";

test("Focus Reader layout policy has exact non-overlapping breakpoint boundaries", () => {
  assert.equal(focusReaderLayout(2_000), "four_column");
  assert.equal(focusReaderLayout(FOCUS_READER_BREAKPOINTS.wide - 1), "three_column");
  assert.equal(focusReaderLayout(FOCUS_READER_BREAKPOINTS.stacked + 1), "three_column");
  assert.equal(focusReaderLayout(FOCUS_READER_BREAKPOINTS.stacked), "stacked");
  assert.equal(focusReaderLayout(FOCUS_READER_BREAKPOINTS.headerWrap), "stacked_compact");
  assert.equal(focusReaderLayout(FOCUS_READER_BREAKPOINTS.phone), "phone");
  assert.equal(focusReaderLayout(Number.NaN), "phone");
});
