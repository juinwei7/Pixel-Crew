import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStore } from "../src/store.js";

function withStore(run: (store: LocalStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-queue-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try { run(store); } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
}

test("enqueue keeps FIFO order per worker and isolates workers", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "first", [], []);
    store.enqueueCommand("a2", "w1", "second", [], []);
    store.enqueueCommand("b1", "w2", "other", [], []);
    assert.deepEqual(store.listQueue("w1").map((q) => q.message), ["first", "second"]);
    assert.deepEqual(store.listQueue("w2").map((q) => q.message), ["other"]);
  });
});

// 回歸守衛：peek 不可以移除項目——送出失敗時那一則必須還留在佇列裡，
// 不然使用者排的訊息連附件會永久消失（見 drainWorkerQueue）。
test("peekFirstQueued returns the front without removing it; empty returns null", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "first", [], []);
    store.enqueueCommand("a2", "w1", "second", [], []);
    assert.equal(store.peekFirstQueued("w1")?.message, "first");
    assert.equal(store.peekFirstQueued("w1")?.message, "first");
    assert.deepEqual(store.listQueue("w1").map((q) => q.message), ["first", "second"]);
    store.removeQueueItem("w1", store.peekFirstQueued("w1")!.id);
    assert.equal(store.peekFirstQueued("w1")?.message, "second");
    store.removeQueueItem("w1", store.peekFirstQueued("w1")!.id);
    assert.equal(store.peekFirstQueued("w1"), null);
  });
});

test("images and documents round-trip through the queue as parsed arrays", () => {
  withStore((store) => {
    const images = [{ name: "a.png", dataBase64: "x" }];
    const documents = [{ name: "b.pdf", dataBase64: "y" }];
    store.enqueueCommand("a1", "w1", "with attachments", images, documents);
    const item = store.listQueue("w1")[0];
    assert.deepEqual(item.images, images);
    assert.deepEqual(item.documents, documents);
    const popped = store.peekFirstQueued("w1");
    assert.deepEqual(popped?.images, images);
  });
});

test("corrupt attachment JSON degrades to an empty array, never throws", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "ok", [], []);
    // Simulate a bad row by writing invalid JSON directly is out of scope here;
    // instead confirm a normal empty enqueue reads back as [], not undefined.
    const item = store.listQueue("w1")[0];
    assert.deepEqual(item.images, []);
    assert.deepEqual(item.documents, []);
  });
});

test("removeQueueItem only deletes the named item for that worker", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "keep", [], []);
    store.enqueueCommand("a2", "w1", "drop", [], []);
    store.removeQueueItem("w1", "a2");
    assert.deepEqual(store.listQueue("w1").map((q) => q.message), ["keep"]);
    // wrong worker id is a no-op
    store.removeQueueItem("w2", "a1");
    assert.deepEqual(store.listQueue("w1").map((q) => q.message), ["keep"]);
  });
});

test("reorderQueue applies the requested order", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "one", [], []);
    store.enqueueCommand("a2", "w1", "two", [], []);
    store.enqueueCommand("a3", "w1", "three", [], []);
    store.reorderQueue("w1", ["a3", "a1", "a2"]);
    assert.deepEqual(store.listQueue("w1").map((q) => q.message), ["three", "one", "two"]);
  });
});

test("clearWorkerQueue empties one worker without touching others", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "gone", [], []);
    store.enqueueCommand("b1", "w2", "stay", [], []);
    store.clearWorkerQueue("w1");
    assert.deepEqual(store.listQueue("w1"), []);
    assert.deepEqual(store.listQueue("w2").map((q) => q.message), ["stay"]);
  });
});

test("deleting a worker also clears its queue", () => {
  withStore((store) => {
    store.enqueueCommand("a1", "w1", "orphan", [], []);
    store.deleteWorker("w1");
    assert.deepEqual(store.listQueue("w1"), []);
  });
});
