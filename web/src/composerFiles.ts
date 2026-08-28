import type { MessageDocumentPayload, MessageImagePayload } from "./types";
import { t } from "./i18n";

export type ComposerImage = MessageImagePayload & { id: string; previewUrl: string; size: number };
export type ComposerDocument = MessageDocumentPayload & { id: string; size: number };

export const MAX_IMAGES = 4;
export const MAX_DOCUMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "html", "htm", "xml", "yaml", "yml", "log", "pdf", "docx", "xlsx", "pptx"]);
export const FILE_ACCEPT = "image/png,image/jpeg,image/webp,.txt,.md,.csv,.json,.html,.htm,.xml,.yaml,.yml,.log,.pdf,.docx,.xlsx,.pptx";

export function validateComposerAttachment(input: {
  imageFiles: File[];
  documentFiles: File[];
  currentImages: ComposerImage[];
  currentDocuments: ComposerDocument[];
}): string | null {
  const { imageFiles, documentFiles, currentImages, currentDocuments } = input;
  if (imageFiles.length > MAX_IMAGES - currentImages.length) return t("每則訊息最多 {max} 張圖片", { max: MAX_IMAGES });
  if (documentFiles.length > MAX_DOCUMENTS - currentDocuments.length) return t("每則訊息最多 {max} 份文件", { max: MAX_DOCUMENTS });
  if (imageFiles.some((file) => !SUPPORTED_IMAGE_TYPES.has(file.type || imageMimeType(file.name)))) return t("只支援 PNG、JPEG 與 WebP 圖片");
  if (imageFiles.some((file) => file.size > MAX_IMAGE_BYTES)) return t("每張圖片不可超過 5 MiB");
  if (currentImages.reduce((sum, image) => sum + image.size, 0) + imageFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) return t("圖片總大小不可超過 10 MiB");
  if (documentFiles.some((file) => !SUPPORTED_DOCUMENT_EXTENSIONS.has(fileExtension(file.name)))) return t("只支援文字、Markdown、CSV、JSON、HTML、XML、YAML、PDF 與 Office 文件");
  if (documentFiles.some((file) => file.size > MAX_DOCUMENT_BYTES)) return t("每份文件不可超過 10 MiB");
  if (currentDocuments.reduce((sum, document) => sum + document.size, 0) + documentFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_DOCUMENT_BYTES) return t("文件總大小不可超過 20 MiB");
  return null;
}

export function imagePayload(image: ComposerImage): MessageImagePayload {
  return { name: image.name, mimeType: image.mimeType, dataBase64: image.dataBase64 };
}

export function documentPayload(document: ComposerDocument): MessageDocumentPayload {
  return { name: document.name, mimeType: document.mimeType, dataBase64: document.dataBase64 };
}

export async function readComposerImage(file: File): Promise<ComposerImage> {
  const previewUrl = await readFileDataUrl(file);
  const dataBase64 = previewUrl.slice(previewUrl.indexOf(",") + 1);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name || `clipboard-${Date.now()}`,
    mimeType: (file.type || imageMimeType(file.name)) as ComposerImage["mimeType"],
    dataBase64,
    previewUrl,
    size: file.size,
  };
}

export async function readComposerDocument(file: File): Promise<ComposerDocument> {
  const dataUrl = await readFileDataUrl(file);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name,
    mimeType: file.type || documentMimeType(file.name),
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    size: file.size,
  };
}

export function fileExtension(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(fileExtension(file.name));
}

export function imageMimeType(name: string): string {
  const extension = fileExtension(name);
  return extension === "png" ? "image/png" : ["jpg", "jpeg"].includes(extension) ? "image/jpeg" : "image/webp";
}

export function documentBadge(name: string): string {
  const extension = fileExtension(name);
  return extension === "md" ? "MD" : extension === "pdf" ? "PDF" : extension.startsWith("doc") ? "DOC" : extension.startsWith("xls") ? "XLS" : extension.startsWith("ppt") ? "PPT" : extension.slice(0, 4).toUpperCase() || "FILE";
}

function documentMimeType(name: string): string {
  const extension = fileExtension(name);
  if (["txt", "log"].includes(extension)) return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "json") return "application/json";
  if (["html", "htm"].includes(extension)) return "text/html";
  if (extension === "xml") return "application/xml";
  if (["yaml", "yml"].includes(extension)) return "application/yaml";
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid attachment"));
    reader.onerror = () => reject(reader.error ?? new Error("attachment read failed"));
    reader.readAsDataURL(file);
  });
}
