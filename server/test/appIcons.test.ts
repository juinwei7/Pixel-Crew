import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

// @ts-expect-error The icon toolchain is intentionally plain JavaScript.
import { COMPACT, CREW, PALETTE, SIZES, layoutFor } from "../../scripts/icons/icon-art.mjs";
// @ts-expect-error The icon toolchain is intentionally plain JavaScript.
import { renderIcon } from "../../scripts/icons/icon-render.mjs";
// @ts-expect-error The icon toolchain is intentionally plain JavaScript.
import { ICNS_SIZES, ICO_SIZES, buildIcns, buildIco, encodePng } from "../../scripts/icons/icon-files.mjs";
// @ts-expect-error The icon toolchain is intentionally plain JavaScript.
import { iconOutputs } from "../../scripts/icons/generate-icons.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const macosPackager = fileURLToPath(new URL("../../scripts/macos/package-app.mjs", import.meta.url));
const controllerProject = fileURLToPath(new URL("../../windows/PixelCrewController/PixelCrewController.csproj", import.meta.url));
const controllerSource = fileURLToPath(new URL("../../windows/PixelCrewController/Program.cs", import.meta.url));

type Image = { size: number; buffer: Buffer };

function alphaAt(image: Image, x: number, y: number): number {
  return image.buffer[(y * image.size + x) * 4 + 3];
}

function colourAt(image: Image, x: number, y: number): number {
  const offset = (y * image.size + x) * 4;
  return (image.buffer[offset] << 16) | (image.buffer[offset + 1] << 8) | image.buffer[offset + 2];
}

test("both marks are well-formed pixel grids drawn from the shared palette", () => {
  for (const art of [CREW, COMPACT]) {
    const width = art.rows[0].length;
    for (const row of art.rows) {
      assert.equal(row.length, width);
      for (const pixel of row) assert.ok(pixel in PALETTE, `undefined palette key: ${pixel}`);
    }
  }

  // The wide mark has to read as a crew, so all three shirt colours must show.
  const crew = CREW.rows.join("");
  for (const shirt of ["B", "G", "A"]) assert.ok(crew.includes(shirt), `missing crew member: ${shirt}`);
  assert.ok(!COMPACT.rows.join("").includes("G"), "the compact mark is a single crew member");
});

test("every size scales the sprite by a whole number and keeps its margin", () => {
  assert.deepEqual(SIZES.map((entry: { size: number }) => entry.size), [16, 32, 48, 64, 128, 256, 512, 1024]);
  for (const { size } of SIZES) {
    const layout = layoutFor(size);
    assert.ok(Number.isInteger(layout.scale) && layout.scale >= 1, `${size}px needs a whole-number scale`);
    const longest = Math.max(layout.width, layout.height);
    assert.equal(longest / size, 0.75, `${size}px should fill three quarters of the canvas`);
    assert.ok(layout.offsetX >= 0 && layout.offsetY >= 0, `${size}px sprite overflows the canvas`);
    assert.ok(layout.offsetY + layout.height <= size, `${size}px sprite overflows the canvas`);
  }
  assert.throws(() => layoutFor(24), /No icon layout is defined for 24px/);
});

test("rendered icons are a transparent squircle around an opaque crew", () => {
  const image: Image = renderIcon(256);
  assert.equal(image.buffer.length, 256 * 256 * 4);
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]]) {
    assert.equal(alphaAt(image, x, y), 0, `corner ${x},${y} should fall outside the squircle`);
  }
  assert.equal(alphaAt(image, 128, 128), 255);
  assert.equal(colourAt(image, 128, 128), PALETTE.B, "the centre of the mark is the brand cyan shirt");

  // 16px drops to the compact mark rather than shrinking three sprites to mush.
  assert.equal(layoutFor(16).rows, COMPACT.rows);
  assert.equal(layoutFor(128).rows, CREW.rows);
});

test("the ICO directory indexes every frame it ships", () => {
  const ico = buildIco(ICO_SIZES.map((size: number) => renderIcon(size)));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  ICO_SIZES.forEach((size: number, index: number) => {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size >= 256 ? 0 : size, `frame ${size} declares the wrong width`);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + ICO_SIZES.length * 16 && offset + length <= ico.length);
    // Small frames stay raw DIBs for the classic shell paths; large ones are PNG.
    const isPng = ico.subarray(offset, offset + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(isPng, size > 48, `frame ${size} uses the wrong encoding`);
  });
});

test("the ICNS fills every slot macOS asks for", () => {
  const icns = buildIcns(new Map(ICNS_SIZES.map((size: number) => [size, renderIcon(size)])));
  assert.equal(icns.subarray(0, 4).toString("latin1"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);

  const slots: string[] = [];
  let cursor = 8;
  while (cursor < icns.length) {
    const type = icns.subarray(cursor, cursor + 4).toString("latin1");
    const length = icns.readUInt32BE(cursor + 4);
    assert.ok(length > 8 && cursor + length <= icns.length, `slot ${type} has a bad length`);
    assert.ok(icns.subarray(cursor + 8, cursor + 12).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    slots.push(type);
    cursor += length;
  }
  assert.deepEqual(slots, ["icp4", "icp5", "ic11", "ic12", "ic07", "ic13", "ic08", "ic14", "ic09"]);
  // macOS 26 frames an .icns that carries a 1024px slot like a picture
  // instead of drawing it as the app's icon, so the set deliberately stops
  // at 512 and lets Finder scale up for the one preview that needs more.
  assert.ok(!slots.includes("ic10"), "a 1024px slot breaks the macOS 26 app-icon treatment");
  assert.throws(() => buildIcns(new Map()), /needs a 16px image/);
});

test("PNG output declares the size it was rendered at", () => {
  const png = encodePng(renderIcon(64));
  assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  assert.equal(png[24], 8, "8 bits per channel");
  assert.equal(png[25], 6, "RGBA");
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** The raw scanlines a PNG carries, independent of how they were compressed. */
function pngScanlines(png: Buffer): Buffer {
  const parts: Buffer[] = [];
  let cursor = 8;
  while (cursor + 8 <= png.length) {
    const length = png.readUInt32BE(cursor);
    const type = png.subarray(cursor + 4, cursor + 8).toString("latin1");
    if (type === "IDAT") parts.push(png.subarray(cursor + 8, cursor + 8 + length));
    if (type === "IEND") break;
    cursor += length + 12;
  }
  return inflateSync(Buffer.concat(parts));
}

function icnsSlots(icns: Buffer): { type: string; payload: Buffer }[] {
  const slots: { type: string; payload: Buffer }[] = [];
  let cursor = 8;
  while (cursor + 8 <= icns.length) {
    const length = icns.readUInt32BE(cursor + 4);
    slots.push({ type: icns.subarray(cursor, cursor + 4).toString("latin1"), payload: icns.subarray(cursor + 8, cursor + length) });
    cursor += length;
  }
  return slots;
}

function icoFrames(ico: Buffer): { size: number; payload: Buffer }[] {
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    return { size: ico[entry] === 0 ? 256 : ico[entry], payload: ico.subarray(offset, offset + length) };
  });
}

const framePixels = (payload: Buffer) =>
  payload.subarray(0, 4).equals(PNG_MAGIC) ? pngScanlines(payload) : payload;

/** Structure plus decoded pixels, so the comparison survives a zlib change. */
function iconDigest(file: Buffer, path: string): string {
  const hash = createHash("sha256");
  if (path.endsWith(".png")) hash.update(pngScanlines(file));
  else if (path.endsWith(".icns")) for (const slot of icnsSlots(file)) hash.update(slot.type).update(framePixels(slot.payload));
  else if (path.endsWith(".ico")) for (const frame of icoFrames(file)) hash.update(String(frame.size)).update(framePixels(frame.payload));
  else throw new Error(`No pixel comparison is defined for ${path}`);
  return hash.digest("hex");
}

test("the committed icon files still match the artwork", () => {
  // Deflate output differs between zlib builds — CI runs Node 22 while a
  // developer may be on a newer one — so identical artwork can still produce
  // different bytes. Compare the decoded pixels instead of the compressed
  // file, which also makes this check verify the artwork rather than a blob.
  for (const output of iconOutputs() as { path: string; data: Buffer }[]) {
    const committed = readFileSync(join(root, output.path));
    const stale = `${output.path} is stale — regenerate the icons with \`npm run icons\``;
    if (output.path.endsWith(".svg")) {
      // Git checks text files out with CRLF on Windows, so compare the text
      // rather than the bytes the working tree happens to hold.
      assert.equal(committed.toString("utf8").replace(/\r\n/g, "\n"), output.data.toString("utf8"), stale);
      continue;
    }
    assert.equal(iconDigest(committed, output.path), iconDigest(output.data, output.path), stale);
  }
});

test("both release packagers ship the generated icon", () => {
  const macos = readFileSync(macosPackager, "utf8");
  assert.match(macos, /assets", "icons", "pixel-crew\.icns"/);
  assert.match(macos, /requireFile\(appIcon, "app icon"\)/);
  assert.match(macos, /cp\(appIcon, join\(resources, "AppIcon\.icns"\)\)/);
  assert.match(macos, /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/);

  const project = readFileSync(controllerProject, "utf8");
  assert.match(project, /<ApplicationIcon>\.\.\/\.\.\/assets\/icons\/pixel-crew\.ico<\/ApplicationIcon>/);
  assert.match(project, /EmbeddedResource Include="\.\.\/\.\.\/assets\/icons\/pixel-crew\.ico" Link="Assets\/pixel-crew\.ico"/);

  const controller = readFileSync(controllerSource, "utf8");
  assert.match(controller, /PixelCrewController\.Assets\.pixel-crew\.ico/);
  assert.match(controller, /Icon = ProductIcon\.Tray\(\)/);
  assert.match(controller, /Icon = ProductIcon\.Window\(\)/);
  assert.match(controller, /SystemInformation\.SmallIconSize/);
});
