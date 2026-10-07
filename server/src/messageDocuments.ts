import type { MessageDocument } from "./providers/session.js";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import { t } from "./i18n.js";
import { MAX_MESSAGE_IMAGES_TOTAL_BYTES } from "./messageImages.js";

export const MAX_MESSAGE_DOCUMENTS = 4;
export const MAX_MESSAGE_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

// HTTP JSON 上限直接從附件預算推出來（base64 每 3 bytes 變 4 字元），再留 2 MiB 給訊息文字、
// 檔名與 JSON 外殼。以前是手寫的固定值，圖片預算調大後沒跟上：滿額圖片＋幾 MiB 文件在
// body-parser 就被擋，連驗證訊息都看不到。個別附件的上限仍由 parseMessage* 把關。
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
export const MESSAGE_JSON_BODY_LIMIT_BYTES =
  base64Length(MAX_MESSAGE_IMAGES_TOTAL_BYTES) + base64Length(MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES) + 2 * 1024 * 1024;

/** body-parser 超過上限時丟的錯誤（type: entity.too.large、status 413）。 */
export function isRequestBodyTooLarge(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { type?: unknown; status?: unknown };
  return value.type === "entity.too.large" || value.status === 413;
}

export function requestBodyTooLargeMessage(): string {
  return t("送出的內容太大：圖片合計最多 {images} MiB、文件合計最多 {documents} MiB，請減少附件後再試。", {
    images: MAX_MESSAGE_IMAGES_TOTAL_BYTES / 1024 / 1024,
    documents: MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES / 1024 / 1024,
  });
}

const DOCUMENT_TYPES: Record<string, { mimeType: string; kind: "text" | "pdf" | "zip" }> = {
  txt: { mimeType: "text/plain", kind: "text" },
  md: { mimeType: "text/markdown", kind: "text" },
  csv: { mimeType: "text/csv", kind: "text" },
  json: { mimeType: "application/json", kind: "text" },
  html: { mimeType: "text/html", kind: "text" },
  htm: { mimeType: "text/html", kind: "text" },
  xml: { mimeType: "application/xml", kind: "text" },
  yaml: { mimeType: "application/yaml", kind: "text" },
  yml: { mimeType: "application/yaml", kind: "text" },
  log: { mimeType: "text/plain", kind: "text" },
  pdf: { mimeType: "application/pdf", kind: "pdf" },
  docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "zip" },
  xlsx: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "zip" },
  pptx: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "zip" },
};

export class MessageDocumentValidationError extends Error {}

export function parseMessageDocuments(value: unknown): MessageDocument[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new MessageDocumentValidationError(t("文件附件格式不正確"));
  if (value.length > MAX_MESSAGE_DOCUMENTS) throw new MessageDocumentValidationError(t("每則訊息最多 {max} 份文件", { max: MAX_MESSAGE_DOCUMENTS }));

  let totalBytes = 0;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new MessageDocumentValidationError(t("第 {n} 份文件格式不正確", { n: index + 1 }));
    const item = raw as Record<string, unknown>;
    const fallback = `document-${index + 1}.txt`;
    const name = String(item.name ?? fallback).replace(/[\\/\r\n\0]/g, "").trim().slice(0, 120) || fallback;
    const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const definition = DOCUMENT_TYPES[extension];
    if (!definition) throw new MessageDocumentValidationError(t("只支援 TXT、Markdown、CSV、JSON、HTML、XML、YAML、PDF 與 Office 文件"));
    const dataBase64 = String(item.dataBase64 ?? "").trim();
    if (!dataBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new MessageDocumentValidationError(t("第 {n} 份文件資料無效", { n: index + 1 }));
    const data = Buffer.from(dataBase64, "base64");
    if (!data.length || data.length > MAX_MESSAGE_DOCUMENT_BYTES) throw new MessageDocumentValidationError(t("每份文件不可超過 {mib} MiB", { mib: MAX_MESSAGE_DOCUMENT_BYTES / 1024 / 1024 }));
    if (!matchesDocumentSignature(data, definition.kind)) throw new MessageDocumentValidationError(t("第 {n} 份文件內容與格式不符", { n: index + 1 }));
    totalBytes += data.length;
    if (totalBytes > MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES) throw new MessageDocumentValidationError(t("文件總大小不可超過 {mib} MiB", { mib: MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES / 1024 / 1024 }));
    return { name, mimeType: definition.mimeType, dataBase64 };
  });
}

export function documentExtension(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "txt";
  return DOCUMENT_TYPES[extension] ? extension : "txt";
}

export function stageMessageDocuments(documents: MessageDocument[], directory: string): Array<{ name: string; path: string }> {
  if (documents.length === 0) return [];
  ensurePrivateDirectorySync(directory);
  const files: Array<{ name: string; path: string }> = [];
  try {
    for (const document of documents) {
      const path = join(directory, `.pixel-crew-document-${randomUUID()}.${documentExtension(document.name)}`);
      writeFileSync(path, Buffer.from(document.dataBase64, "base64"), { mode: 0o600 });
      protectFileSync(path);
      files.push({ name: document.name, path });
    }
    return files;
  } catch (error) {
    for (const file of files) rmSync(file.path, { force: true });
    throw error;
  }
}

export function documentPrompt(files: Array<{ name: string; path: string }>): string {
  if (files.length === 0) return "";
  const list = files.map((file, index) => `${index + 1}. ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join("\n");
  return t("Pixel Crew 已將使用者附加的文件暫存為以下唯讀檔案。請把它們視為本次訊息的附件，依使用者要求用讀檔工具檢視；不要修改或刪除附件：\n{list}", { list });
}

function matchesDocumentSignature(data: Buffer, kind: "text" | "pdf" | "zip"): boolean {
  if (kind === "pdf") return data.subarray(0, 5).toString("ascii") === "%PDF-";
  if (kind === "zip") return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && [0x03, 0x05, 0x07].includes(data[2]) && [0x04, 0x06, 0x08].includes(data[3]);
  // Reject binary/executable payloads disguised with a text extension.
  return !data.subarray(0, Math.min(data.length, 8192)).includes(0);
}
