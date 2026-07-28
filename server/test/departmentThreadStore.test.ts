import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStore } from "../src/store.js";

test("persists one permanent thread, idempotent messages, attachments, delivery, and audit", () => {
  const directory = mkdtempSync(join(tmpdir(), "pixel-crew-thread-store-"));
  const store = new LocalStore(join(directory, "test.sqlite"));
  try {
    store.saveWorker({
      id: "lead", name: "Lead", model: null, colorIndex: 0, avatarId: null, avatarKind: "preset", avatarPresetId: "classic",
      provider: "claude", workspacePath: "/repo", sessionId: "s", completedTurns: 0, persona: null, autoApproveMode: "off", departmentId: "department",
    });
    const now = "2026-07-23T00:00:00.000Z";
    store.saveDepartment({ id: "department", name: "Engineering", purpose: "Build", workspacePath: "/repo", leadWorkerId: "lead", memberWorkerIds: ["lead"], createdAt: now, updatedAt: now });
    assert.equal(store.saveDepartmentThread({ id: "thread", departmentId: "department", activeMissionId: null, summary: "", historyClearedAt: null, lastMessageAt: now, createdAt: now, updatedAt: now }), true);
    assert.equal(store.saveAttachment({ id: "attachment", name: "spec.md", mimeType: "text/markdown", size: 4, checksum: "abc", storageKey: "abc.md", kind: "document", createdAt: now }), true);
    assert.equal(store.saveDepartmentMessage({
      id: "message", threadId: "thread", role: "owner", intent: "follow_up_mission", text: "Build it",
      attachmentIds: ["attachment"], missionId: null, deliveryStatus: "delivered", clientMessageId: "client", idempotencyKey: "idem",
      classification: { intent: "follow_up_mission", confidence: 1, reason: "new work", changeImpact: "none", clarificationQuestion: null }, createdAt: now,
    }), true);
    assert.equal(store.saveAttachmentDelivery("attachment", "mission", "lead", "delivered"), true);
    assert.equal(store.saveAuditEvent({ id: "audit", departmentId: "department", type: "Attachment Added", payload: { attachmentId: "attachment" }, createdAt: now }), true);

    assert.equal(store.getDepartmentThread("department")?.id, "thread");
    assert.equal(store.listDepartmentMessages("thread")[0]?.text, "Build it");
    assert.equal(store.getDepartmentMessageByIdempotency("idem")?.id, "message");
    assert.equal(store.getAttachmentByChecksum("abc")?.name, "spec.md");
    assert.equal(store.listAuditEvents("department")[0]?.type, "Attachment Added");
    const clearedAt = "2026-07-23T01:00:00.000Z";
    assert.equal(store.saveDepartmentThread({ ...store.getDepartmentThread("department")!, historyClearedAt: clearedAt, summary: "" }), true);
    assert.equal(store.getDepartmentThread("department")?.historyClearedAt, clearedAt);
    assert.equal(store.listDepartmentMessages("thread")[0]?.text, "Build it", "logical reset must preserve auditable rows");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
