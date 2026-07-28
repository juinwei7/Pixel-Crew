import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { MessageDocument, MessageImage } from "./providers/session.js";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";

export type AttachmentKind = "image" | "document";
export type AttachmentRecord = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  checksum: string;
  storageKey: string;
  kind: AttachmentKind;
  createdAt: string;
};

type AttachmentStorePort = {
  getAttachmentByChecksum(checksum: string): AttachmentRecord | null;
  saveAttachment(attachment: AttachmentRecord): boolean;
  getAttachment(id: string): AttachmentRecord | null;
  saveAttachmentDelivery(attachmentId: string, missionId: string, workerId: string, status: "pending" | "delivered" | "failed", error?: string | null): boolean;
};

export class AttachmentRepository {
  constructor(private readonly directory: string, private readonly store: AttachmentStorePort) {
    ensurePrivateDirectorySync(directory);
  }

  persist(images: MessageImage[], documents: MessageDocument[]): AttachmentRecord[] {
    return [
      ...images.map((image) => this.persistOne(image.name, image.mimeType, image.dataBase64, "image")),
      ...documents.map((document) => this.persistOne(document.name, document.mimeType, document.dataBase64, "document")),
    ];
  }

  load(ids: string[]): { images: MessageImage[]; documents: MessageDocument[] } {
    const images: MessageImage[] = [];
    const documents: MessageDocument[] = [];
    for (const id of ids) {
      const attachment = this.store.getAttachment(id);
      if (!attachment) continue;
      const path = join(this.directory, attachment.storageKey);
      if (!existsSync(path)) {
        console.warn(`附件檔案遺失，已略過：${attachment.id} (${attachment.name})`);
        continue;
      }
      const dataBase64 = readFileSync(path).toString("base64");
      if (attachment.kind === "image") {
        images.push({ name: attachment.name, mimeType: attachment.mimeType as MessageImage["mimeType"], dataBase64 });
      } else {
        documents.push({ name: attachment.name, mimeType: attachment.mimeType, dataBase64 });
      }
    }
    return { images, documents };
  }

  markDelivery(attachmentIds: string[], missionId: string, workerId: string, status: "pending" | "delivered" | "failed", error: string | null = null): void {
    for (const attachmentId of attachmentIds) this.store.saveAttachmentDelivery(attachmentId, missionId, workerId, status, error);
  }

  private persistOne(name: string, mimeType: string, dataBase64: string, kind: AttachmentKind): AttachmentRecord {
    const data = Buffer.from(dataBase64, "base64");
    const checksum = createHash("sha256").update(data).digest("hex");
    const existing = this.store.getAttachmentByChecksum(checksum);
    if (existing) return existing;
    const safeExtension = extname(name).replace(/[^.a-z0-9]/gi, "").slice(0, 12);
    const storageKey = `${checksum}${safeExtension}`;
    const path = join(this.directory, storageKey);
    if (!existsSync(path)) {
      writeFileSync(path, data, { mode: 0o600, flag: "wx" });
      protectFileSync(path);
    }
    const attachment: AttachmentRecord = {
      id: randomUUID(),
      name: name.replace(/[\\/\r\n\0]/g, "").trim().slice(0, 120) || "attachment",
      mimeType: mimeType.slice(0, 200),
      size: data.length,
      checksum,
      storageKey,
      kind,
      createdAt: new Date().toISOString(),
    };
    if (!this.store.saveAttachment(attachment)) throw new Error("無法保存附件索引");
    return attachment;
  }
}
