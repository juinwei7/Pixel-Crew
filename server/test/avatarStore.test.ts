import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { AvatarStore, AvatarValidationError } from "../src/avatarStore.js";

test("stores only validated 24x32 PNG files with private permissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-avatar-"));
  try {
    const store = new AvatarStore(join(directory, "avatars"));
    const png = makePng(24, 32);
    const id = await store.save(png.toString("base64"));
    assert.match(id, /^[0-9a-f-]{36}\.png$/);
    assert.deepEqual(await store.read(id), { data: png, mimeType: "image/png" });
    assert.equal(statSync(join(directory, "avatars", id)).mode & 0o777, 0o600);
    assert.equal(await store.read("../../secret"), null);
    await store.delete(id);
    assert.equal(await store.read(id), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores a real multi-frame GIF without flattening its animation bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-avatar-gif-"));
  try {
    const store = new AvatarStore(directory);
    const gif = makeGif(2);
    const id = await store.save(gif.toString("base64"), "image/gif");
    assert.match(id, /\.gif$/);
    assert.deepEqual(await store.read(id), { data: gif, mimeType: "image/gif" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects GIF files that exceed frame or decoded-pixel budgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-avatar-gif-budget-"));
  try {
    const store = new AvatarStore(directory);
    await assert.rejects(
      store.save(makeGif(121).toString("base64"), "image/gif"),
      /影格上限/,
    );
    await assert.rejects(
      store.save(makeGif(79, 320, 320).toString("base64"), "image/gif"),
      /解碼像素預算/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects truncated GIF block data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-avatar-gif-truncated-"));
  try {
    const store = new AvatarStore(directory);
    const gif = makeGif(2).subarray(0, -2);
    await assert.rejects(store.save(gif.toString("base64"), "image/gif"), AvatarValidationError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects wrong dimensions and corrupt PNG data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-avatar-invalid-"));
  try {
    const store = new AvatarStore(directory);
    await assert.rejects(store.save(makePng(12, 16).toString("base64")), AvatarValidationError);
    const corrupt = makePng(24, 32);
    corrupt[corrupt.length - 1] ^= 0xff;
    await assert.rejects(store.save(corrupt.toString("base64")), AvatarValidationError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row++) scanlines[row * (1 + width * 4)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeGif(frameCount: number, width = 1, height = 1): Buffer {
  const logicalScreen = Buffer.alloc(7);
  logicalScreen.writeUInt16LE(width, 0);
  logicalScreen.writeUInt16LE(height, 2);
  logicalScreen[4] = 0x80;
  const frame = (colorIndex: 0 | 1) => Buffer.from([
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x00,
    0x02,
    0x02, colorIndex === 0 ? 0x44 : 0x4c, 0x01,
    0x00,
  ]);
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    logicalScreen,
    Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
    ...Array.from({ length: frameCount }, (_, index) => frame(index % 2 === 0 ? 0 : 1)),
    Buffer.from([0x3b]),
  ]);
}

function chunk(type: string, content: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + content.length);
  result.writeUInt32BE(content.length, 0);
  name.copy(result, 4);
  content.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, content])), 8 + content.length);
  return result;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
