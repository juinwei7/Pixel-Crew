import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PASTE_IMAGES, PASTE_INJECT_GAP_MS, clipboardImages } from "../src/blackWindowPaste";

const file = (type: string, name = "pasted") => ({ type, name });

test("only real image types are pulled out of a paste", () => {
  const clipboard = { files: [file("text/plain"), file("image/png"), file("image/webp"), file("application/pdf")] };
  assert.deepEqual(clipboardImages(clipboard).map((item) => item.type), ["image/png", "image/webp"]);
});

test("a text-only paste is left to xterm", () => {
  assert.deepEqual(clipboardImages({ files: [file("text/plain")] }), []);
  assert.deepEqual(clipboardImages({ files: [] }), []);
  assert.deepEqual(clipboardImages({}), []);
  assert.deepEqual(clipboardImages(null), []);
});

test("a paste is capped at the same count the server accepts", () => {
  const clipboard = { files: Array.from({ length: MAX_PASTE_IMAGES + 3 }, () => file("image/png")) };
  assert.equal(clipboardImages(clipboard).length, MAX_PASTE_IMAGES);
});

test("the inject gap stays long enough to split PTY reads", () => {
  // Both CLI composers only recognise one image path per chunk, so paths are
  // typed one at a time with a gap between them.
  assert.ok(PASTE_INJECT_GAP_MS >= 50);
});
