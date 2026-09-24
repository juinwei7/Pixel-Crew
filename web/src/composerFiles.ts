import type { MessageDocumentPayload, MessageImagePayload } from "./types";
import { t } from "./i18n";

// videoName：若這張圖是從某支影片抽出的關鍵影格，記下來源影片檔名，讓輸入框把同一支
// 影片的多張影格收合成「一個」影片附件晶片顯示（而不是一坨縮圖）。
export type ComposerImage = MessageImagePayload & { id: string; previewUrl: string; size: number; videoName?: string };
export type ComposerDocument = MessageDocumentPayload & { id: string; size: number };

export const MAX_IMAGES = 10;
export const MAX_DOCUMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "html", "htm", "xml", "yaml", "yml", "log", "pdf", "docx", "xlsx", "pptx"]);
// 影片：Claude 不吃影片，上傳後由 server 用 ffmpeg 抽關鍵影格＋whisper 轉音訊字幕，再當成
// 圖片＋文字送出（見 /api/video/process）。這裡只認得副檔名/型別，實際處理在 server。
export const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-msvideo"]);
export const SUPPORTED_VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const FILE_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.mkv,.avi,.m4v,.txt,.md,.csv,.json,.html,.htm,.xml,.yaml,.yml,.log,.pdf,.docx,.xlsx,.pptx";

export function isVideoFile(file: File): boolean {
  if (SUPPORTED_VIDEO_TYPES.has(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_VIDEO_EXTENSIONS.has(ext);
}

// 貼連結看影片：認得常見影片平台的網址，讓輸入框冒出「解析這支影片」按鈕（yt-dlp 支援
// 上千站，這裡只列最常見的幾家做自動偵測；其餘站點仍可由 server 端下載，只是不自動提示）。
const VIDEO_URL_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com|douyin\.com|iesdouyin\.com|bilibili\.com|b23\.tv|vimeo\.com|facebook\.com|fb\.watch|instagram\.com|twitter\.com|x\.com|twitch\.tv|dailymotion\.com|nicovideo\.jp|kuaishou\.com)$/i;
export function detectVideoUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s]+/gi);
  if (!matches) return null;
  for (const raw of matches) {
    const cleaned = raw.replace(/[)\]}.,、。！？"'>]+$/, ""); // 去掉句尾標點
    try {
      const host = new URL(cleaned).hostname;
      if (VIDEO_URL_HOSTS.test(host)) return cleaned;
    } catch { /* 不是合法 URL，跳過 */ }
  }
  return null;
}

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
  if (currentImages.reduce((sum, image) => sum + image.size, 0) + imageFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) return t("圖片總大小不可超過 {mib} MiB", { mib: MAX_TOTAL_IMAGE_BYTES / 1024 / 1024 });
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
