import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_DOCUMENT_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  validateComposerAttachment,
} from "../src/composerFiles";

function fakeFile(name: string, type: string, size: number): File {
  return { name, type, size } as unknown as File;
}

test("no error when attachments are within every limit", () => {
  const result = validateComposerAttachment({
    imageFiles: [fakeFile("a.png", "image/png", 1024)],
    documentFiles: [fakeFile("b.md", "text/markdown", 1024)],
    currentImages: [],
    currentDocuments: [],
  });
  assert.equal(result, null);
});

test("rejects too many images given current count", () => {
  const result = validateComposerAttachment({
    imageFiles: [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1)],
    documentFiles: [],
    currentImages: new Array(MAX_IMAGES - 1).fill(0).map((_, index) => ({ id: `${index}`, size: 1 }) as never),
    currentDocuments: [],
  });
  assert.match(result ?? "", new RegExp(`最多 ${MAX_IMAGES} 張圖片`));
});

test("rejects too many documents given current count", () => {
  const result = validateComposerAttachment({
    imageFiles: [],
    documentFiles: [fakeFile("a.md", "text/markdown", 1), fakeFile("b.md", "text/markdown", 1)],
    currentImages: [],
    currentDocuments: new Array(MAX_DOCUMENTS - 1).fill(0).map((_, index) => ({ id: `${index}`, size: 1 }) as never),
  });
  assert.match(result ?? "", new RegExp(`最多 ${MAX_DOCUMENTS} 份文件`));
});

test("rejects an unsupported image type", () => {
  const result = validateComposerAttachment({
    imageFiles: [fakeFile("a.gif", "image/gif", 1)],
    documentFiles: [],
    currentImages: [],
    currentDocuments: [],
  });
  assert.match(result ?? "", /只支援 PNG、JPEG 與 WebP 圖片/);
});

test("rejects an oversized single image", () => {
  const result = validateComposerAttachment({
    imageFiles: [fakeFile("a.png", "image/png", MAX_IMAGE_BYTES + 1)],
    documentFiles: [],
    currentImages: [],
    currentDocuments: [],
  });
  assert.match(result ?? "", /每張圖片不可超過/);
});

test("rejects when total image bytes would exceed the cap", () => {
  const result = validateComposerAttachment({
    imageFiles: [fakeFile("a.png", "image/png", MAX_IMAGE_BYTES), fakeFile("b.png", "image/png", MAX_IMAGE_BYTES)],
    documentFiles: [],
    currentImages: [{ size: MAX_TOTAL_IMAGE_BYTES - MAX_IMAGE_BYTES } as never],
    currentDocuments: [],
  });
  assert.match(result ?? "", /圖片總大小不可超過/);
});

test("rejects an unsupported document extension", () => {
  const result = validateComposerAttachment({
    imageFiles: [],
    documentFiles: [fakeFile("a.exe", "application/octet-stream", 1)],
    currentImages: [],
    currentDocuments: [],
  });
  assert.match(result ?? "", /只支援文字、Markdown/);
});

test("rejects an oversized single document", () => {
  const result = validateComposerAttachment({
    imageFiles: [],
    documentFiles: [fakeFile("a.md", "text/markdown", MAX_DOCUMENT_BYTES + 1)],
    currentImages: [],
    currentDocuments: [],
  });
  assert.match(result ?? "", /每份文件不可超過/);
});

test("rejects when total document bytes would exceed the cap", () => {
  const result = validateComposerAttachment({
    imageFiles: [],
    documentFiles: [fakeFile("a.md", "text/markdown", MAX_DOCUMENT_BYTES), fakeFile("b.md", "text/markdown", MAX_DOCUMENT_BYTES)],
    currentImages: [],
    currentDocuments: [{ size: MAX_TOTAL_DOCUMENT_BYTES - MAX_DOCUMENT_BYTES } as never],
  });
  assert.match(result ?? "", /文件總大小不可超過/);
});
