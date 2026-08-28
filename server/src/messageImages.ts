import type { MessageImage } from "./providers/session.js";
import { t } from "./i18n.js";

export const MAX_MESSAGE_IMAGES = 4;
export const MAX_MESSAGE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES_TOTAL_BYTES = 10 * 1024 * 1024;

const MIME_TYPES = new Set<MessageImage["mimeType"]>(["image/png", "image/jpeg", "image/webp"]);

export class MessageImageValidationError extends Error {}

export function parseMessageImages(value: unknown): MessageImage[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new MessageImageValidationError(t("圖片附件格式不正確"));
  if (value.length > MAX_MESSAGE_IMAGES) throw new MessageImageValidationError(t("每則訊息最多 {max} 張圖片", { max: MAX_MESSAGE_IMAGES }));

  let totalBytes = 0;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new MessageImageValidationError(t("第 {n} 張圖片格式不正確", { n: index + 1 }));
    const item = raw as Record<string, unknown>;
    const mimeType = String(item.mimeType ?? "") as MessageImage["mimeType"];
    if (!MIME_TYPES.has(mimeType)) throw new MessageImageValidationError(t("只支援 PNG、JPEG 與 WebP 圖片"));
    const dataBase64 = String(item.dataBase64 ?? "").trim();
    if (!dataBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new MessageImageValidationError(t("第 {n} 張圖片資料無效", { n: index + 1 }));
    const data = Buffer.from(dataBase64, "base64");
    if (!data.length || data.length > MAX_MESSAGE_IMAGE_BYTES) throw new MessageImageValidationError(t("每張圖片不可超過 {mib} MiB", { mib: MAX_MESSAGE_IMAGE_BYTES / 1024 / 1024 }));
    if (!matchesImageSignature(data, mimeType)) throw new MessageImageValidationError(t("第 {n} 張圖片內容與格式不符", { n: index + 1 }));
    totalBytes += data.length;
    if (totalBytes > MAX_MESSAGE_IMAGES_TOTAL_BYTES) throw new MessageImageValidationError(t("圖片總大小不可超過 {mib} MiB", { mib: MAX_MESSAGE_IMAGES_TOTAL_BYTES / 1024 / 1024 }));
    const fallback = `image-${index + 1}.${mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp"}`;
    const name = String(item.name ?? fallback).replace(/[\r\n\0]/g, "").trim().slice(0, 120) || fallback;
    return { name, mimeType, dataBase64 };
  });
}

function matchesImageSignature(data: Buffer, mimeType: MessageImage["mimeType"]): boolean {
  if (mimeType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
}
