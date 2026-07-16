import assert from "node:assert/strict";
import test from "node:test";
import { MessageImageValidationError, parseMessageImages } from "../src/messageImages.js";

const png = "iVBORw0KGgo=";

test("accepts bounded image attachments and sanitizes display names", () => {
  assert.deepEqual(parseMessageImages([{ name: "shot\n.png", mimeType: "image/png", dataBase64: png }]), [{
    name: "shot.png",
    mimeType: "image/png",
    dataBase64: png,
  }]);
});

test("rejects spoofed image types and too many attachments", () => {
  assert.throws(() => parseMessageImages([{ name: "fake.jpg", mimeType: "image/jpeg", dataBase64: png }]), MessageImageValidationError);
  assert.throws(() => parseMessageImages(Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, mimeType: "image/png", dataBase64: png }))), /最多 4 張/);
});
