import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const AVATAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|gif)$/i;
const MAX_AVATAR_BYTES = 32 * 1024;
const MAX_GIF_BYTES = 2 * 1024 * 1024;
const MAX_GIF_DIMENSION = 320;
const MAX_GIF_FRAMES = 120;
const MAX_GIF_DECODED_PIXELS = 8_000_000;
const AVATAR_WIDTH = 24;
const AVATAR_HEIGHT = 32;

export class AvatarValidationError extends Error {}

export class AvatarStore {
  constructor(private readonly directory: string) {}

  async save(dataBase64: unknown, mimeType: unknown = "image/png"): Promise<string> {
    const type = mimeType === "image/gif" ? "image/gif" : mimeType === "image/png" ? "image/png" : null;
    const maxBytes = type === "image/gif" ? MAX_GIF_BYTES : MAX_AVATAR_BYTES;
    if (!type) throw new AvatarValidationError("只接受 PNG 或 GIF 角色圖片");
    if (typeof dataBase64 !== "string" || !dataBase64 || dataBase64.length > Math.ceil(maxBytes * 4 / 3) + 4) {
      throw new AvatarValidationError("角色圖片資料無效或過大");
    }
    let data: Buffer;
    try {
      data = Buffer.from(dataBase64, "base64");
    } catch {
      throw new AvatarValidationError("角色圖片不是有效的 Base64");
    }
    if (data.length === 0 || data.length > maxBytes || data.toString("base64").replace(/=+$/, "") !== dataBase64.replace(/=+$/, "")) {
      throw new AvatarValidationError("角色圖片資料無效或過大");
    }
    if (type === "image/gif") validateGif(data);
    else validatePng(data);

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const id = `${randomUUID()}.${type === "image/gif" ? "gif" : "png"}`;
    const target = this.pathFor(id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return id;
  }

  async read(id: string): Promise<{ data: Buffer; mimeType: "image/png" | "image/gif" } | null> {
    if (!AVATAR_ID.test(id)) return null;
    try {
      return {
        data: await readFile(this.pathFor(id)),
        mimeType: id.toLowerCase().endsWith(".gif") ? "image/gif" : "image/png",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    if (!AVATAR_ID.test(id)) return;
    await rm(this.pathFor(id), { force: true });
  }

  private pathFor(id: string): string {
    return join(this.directory, id);
  }
}

function validateGif(data: Buffer): void {
  if (data.length < 14 || !["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) {
    throw new AvatarValidationError("角色動畫必須是有效的 GIF");
  }
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  if (!width || !height || width > MAX_GIF_DIMENSION || height > MAX_GIF_DIMENSION) {
    throw new AvatarValidationError(`GIF 尺寸最大為 ${MAX_GIF_DIMENSION} × ${MAX_GIF_DIMENSION} 像素`);
  }
  const packed = data[10];
  const globalColorTableBytes = packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
  let cursor = 13 + globalColorTableBytes;
  let frames = 0;
  let sawTrailer = false;

  while (cursor < data.length) {
    const blockType = data[cursor++];
    if (blockType === 0x3b) {
      if (cursor !== data.length) throw new AvatarValidationError("GIF 結尾包含多餘資料");
      sawTrailer = true;
      break;
    }
    if (blockType === 0x21) {
      if (cursor >= data.length) throw new AvatarValidationError("GIF extension 不完整");
      cursor++; // Extension label.
      cursor = skipGifSubBlocks(data, cursor);
      continue;
    }
    if (blockType !== 0x2c || cursor + 9 > data.length) {
      throw new AvatarValidationError("GIF block 結構無效");
    }

    const frameWidth = data.readUInt16LE(cursor + 4);
    const frameHeight = data.readUInt16LE(cursor + 6);
    const framePacked = data[cursor + 8];
    if (!frameWidth || !frameHeight) throw new AvatarValidationError("GIF frame 尺寸無效");
    cursor += 9;
    if (framePacked & 0x80) cursor += 3 * 2 ** ((framePacked & 0x07) + 1);
    if (cursor >= data.length) throw new AvatarValidationError("GIF frame 資料不完整");
    const lzwMinimumCodeSize = data[cursor++];
    if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) {
      throw new AvatarValidationError("GIF LZW 編碼無效");
    }
    cursor = skipGifSubBlocks(data, cursor);
    frames++;
    if (frames > MAX_GIF_FRAMES) throw new AvatarValidationError(`GIF 超過 ${MAX_GIF_FRAMES} 個影格上限`);
    if (width * height * frames > MAX_GIF_DECODED_PIXELS) {
      throw new AvatarValidationError("GIF 超過安全解碼像素預算，請縮短動畫或降低尺寸");
    }
  }
  if (!sawTrailer || frames === 0) throw new AvatarValidationError("GIF 沒有完整的圖片 frame");
}

function skipGifSubBlocks(data: Buffer, start: number): number {
  let cursor = start;
  while (cursor < data.length) {
    const length = data[cursor++];
    if (length === 0) return cursor;
    if (cursor + length > data.length) throw new AvatarValidationError("GIF data sub-block 不完整");
    cursor += length;
  }
  throw new AvatarValidationError("GIF data sub-block 缺少結尾");
}

function validatePng(data: Buffer): void {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AvatarValidationError("角色圖片必須是 PNG");
  }
  if (data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new AvatarValidationError("PNG 標頭無效");
  }
  if (data.readUInt32BE(16) !== AVATAR_WIDTH || data.readUInt32BE(20) !== AVATAR_HEIGHT) {
    throw new AvatarValidationError(`角色圖片必須正好是 ${AVATAR_WIDTH} × ${AVATAR_HEIGHT} 像素`);
  }
  const bitDepth = data[24];
  const colorType = data[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new AvatarValidationError("角色 PNG 必須使用 8-bit RGB 或 RGBA 色彩");
  }
  if (data[26] !== 0 || data[27] !== 0 || data[28] !== 0) {
    throw new AvatarValidationError("角色 PNG 必須使用標準非交錯格式");
  }

  const idat: Buffer[] = [];
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new AvatarValidationError("PNG 區塊不完整");
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_AVATAR_BYTES || end > data.length) throw new AvatarValidationError("PNG 區塊無效");
    const type = data.toString("ascii", offset + 4, offset + 8);
    const content = data.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = data.readUInt32BE(offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw new AvatarValidationError("PNG 校驗失敗");
    }
    if (!sawHeader) {
      if (type !== "IHDR") throw new AvatarValidationError("PNG 首個區塊必須是 IHDR");
      sawHeader = true;
    } else if (type === "IHDR") {
      throw new AvatarValidationError("PNG 包含重複標頭");
    }
    if (type === "IDAT") idat.push(content);
    if (type === "IEND") {
      if (length !== 0 || end !== data.length) throw new AvatarValidationError("PNG 結尾無效");
      sawEnd = true;
    }
    offset = end;
  }
  if (!sawEnd || idat.length === 0) throw new AvatarValidationError("PNG 缺少圖片資料");
  try {
    const raw = inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : 3;
    const rowSize = 1 + AVATAR_WIDTH * channels;
    if (raw.length !== rowSize * AVATAR_HEIGHT) throw new Error("unexpected scanline size");
    for (let row = 0; row < AVATAR_HEIGHT; row++) {
      if (raw[row * rowSize] > 4) throw new Error("invalid PNG filter");
    }
  } catch {
    throw new AvatarValidationError("PNG 圖片資料無法解壓縮");
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
