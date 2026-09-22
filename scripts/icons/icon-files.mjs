// PNG, ICO and ICNS writers for the generated icon.
//
// Windows and macOS both want a container holding several sizes, and neither
// format is complicated enough to justify pulling an image toolkit into a
// local-first app. `node:zlib` supplies the only compression involved.

import { deflateSync } from "node:zlib";

// Windows' Icon class has handled PNG-compressed frames since Vista, but the
// classic shell paths still read small icons most reliably as raw DIBs, so
// anything at or below this size is written as an uncompressed bitmap.
const ICO_BITMAP_LIMIT = 48;

export function encodePng({ size, buffer }) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    buffer.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value;
    }
  }
  let value = -1;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return value ^ -1;
}

/** A 32-bit bottom-up DIB plus the (fully transparent) AND mask an ICO needs. */
export function encodeIcoBitmap({ size, buffer }) {
  const maskStride = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // image plus mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + maskStride * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const source = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const from = source + x * 4;
      const to = (y * size + x) * 4;
      pixels[to] = buffer[from + 2];
      pixels[to + 1] = buffer[from + 1];
      pixels[to + 2] = buffer[from];
      pixels[to + 3] = buffer[from + 3];
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)]);
}

/** @param images {{ size: number, buffer: Buffer }[]} */
export function buildIco(images) {
  if (!images.length) throw new Error("An .ico needs at least one image");
  const entries = images.map((image) => ({
    size: image.size,
    data: image.size <= ICO_BITMAP_LIMIT ? encodeIcoBitmap(image) : encodePng(image),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon, not cursor
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length + entries.length * 16;
  const directory = entries.map((entry) => {
    const record = Buffer.alloc(16);
    record[0] = entry.size >= 256 ? 0 : entry.size; // 0 means 256
    record[1] = entry.size >= 256 ? 0 : entry.size;
    record.writeUInt16LE(1, 4); // colour planes
    record.writeUInt16LE(32, 6); // bits per pixel
    record.writeUInt32LE(entry.data.length, 8);
    record.writeUInt32LE(offset, 12);
    offset += entry.data.length;
    return record;
  });
  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.data)]);
}

// OSType per icon slot. macOS picks a slot by its declared size, so the same
// bitmap is filed twice wherever a size doubles as another size's @2x variant.
//
// There is deliberately no `ic10` (1024px) slot. macOS 26 renders an .icns
// that carries one as a framed picture sitting on the system's default tile
// instead of as the app's own icon; without it the same artwork fills the
// icon shape properly. Finder scales `ic09` for the rare 1024px preview.
const ICNS_SLOTS = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "ic11", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic13", size: 256 },
  { type: "ic08", size: 256 },
  { type: "ic14", size: 512 },
  { type: "ic09", size: 512 },
];

/** @param images {Map<number, { size: number, buffer: Buffer }>} */
export function buildIcns(images) {
  const chunks = ICNS_SLOTS.map(({ type, size }) => {
    const image = images.get(size);
    if (!image) throw new Error(`The .icns slot ${type} needs a ${size}px image`);
    const png = encodePng(image);
    const header = Buffer.alloc(8);
    header.write(type, 0, "latin1");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

export const ICO_SIZES = [16, 32, 48, 64, 128, 256];
export const ICNS_SIZES = [...new Set(ICNS_SLOTS.map((slot) => slot.size))];
