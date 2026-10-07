import assert from "node:assert/strict";
import test from "node:test";
import {
  documentPrompt,
  isRequestBodyTooLarge,
  MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES,
  MESSAGE_JSON_BODY_LIMIT_BYTES,
  MessageDocumentValidationError,
  parseMessageDocuments,
  requestBodyTooLargeMessage,
} from "../src/messageDocuments.js";
import { MAX_MESSAGE_IMAGES_TOTAL_BYTES } from "../src/messageImages.js";

test("accepts supported text, PDF, and Office document attachments", () => {
  const text = Buffer.from("# Notes\nhello").toString("base64");
  const pdf = Buffer.from("%PDF-1.7\nmock").toString("base64");
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).toString("base64");
  const parsed = parseMessageDocuments([
    { name: "notes\n.md", mimeType: "text/markdown", dataBase64: text },
    { name: "report.pdf", mimeType: "application/pdf", dataBase64: pdf },
    { name: "brief.docx", mimeType: "application/octet-stream", dataBase64: docx },
  ]);
  assert.deepEqual(parsed.map(({ name, mimeType }) => ({ name, mimeType })), [
    { name: "notes.md", mimeType: "text/markdown" },
    { name: "report.pdf", mimeType: "application/pdf" },
    { name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ]);
});

test("rejects unsupported, spoofed, binary text, and excessive documents", () => {
  const text = Buffer.from("hello").toString("base64");
  assert.throws(() => parseMessageDocuments([{ name: "script.exe", dataBase64: text }]), MessageDocumentValidationError);
  assert.throws(() => parseMessageDocuments([{ name: "fake.pdf", dataBase64: text }]), /內容與格式不符/);
  assert.throws(() => parseMessageDocuments([{ name: "fake.txt", dataBase64: Buffer.from([0, 1, 2]).toString("base64") }]), /內容與格式不符/);
  assert.throws(() => parseMessageDocuments(Array.from({ length: 5 }, (_, index) => ({ name: `${index}.txt`, dataBase64: text }))), /最多 4 份/);
});

test("builds a bounded attachment instruction with quoted names and paths", () => {
  const prompt = documentPrompt([{ name: "my notes.md", path: "/tmp/file.md" }]);
  assert.match(prompt, /唯讀檔案/);
  assert.match(prompt, /"my notes\.md": "\/tmp\/file\.md"/);
});

test("the HTTP JSON limit fits a full image budget plus a full document budget as base64", () => {
  const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4;
  const fullPayload = JSON.stringify({
    message: "x".repeat(4_000),
    images: [{ name: "a.png", mimeType: "image/png", dataBase64: "A".repeat(base64(MAX_MESSAGE_IMAGES_TOTAL_BYTES)) }],
    documents: [{ name: "a.pdf", mimeType: "application/pdf", dataBase64: "A".repeat(base64(MAX_MESSAGE_DOCUMENTS_TOTAL_BYTES)) }],
  });
  assert.ok(Buffer.byteLength(fullPayload) <= MESSAGE_JSON_BODY_LIMIT_BYTES);
  // 30 MiB 圖片＋超過 3 MiB 文件以前會撞上手寫的 44mb 而變成通用 500。
  assert.ok(MESSAGE_JSON_BODY_LIMIT_BYTES > 44 * 1024 * 1024);
});

test("oversized request bodies are recognised so they can be answered with a clear 413", () => {
  assert.equal(isRequestBodyTooLarge({ type: "entity.too.large", status: 413 }), true);
  assert.equal(isRequestBodyTooLarge({ status: 413 }), true);
  assert.equal(isRequestBodyTooLarge({ type: "entity.parse.failed", status: 400 }), false);
  assert.equal(isRequestBodyTooLarge(new Error("boom")), false);
  assert.equal(isRequestBodyTooLarge(null), false);
  assert.match(requestBodyTooLargeMessage(), /30 MiB.*20 MiB/);
});
