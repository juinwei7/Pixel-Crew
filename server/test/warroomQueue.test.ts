import assert from "node:assert/strict";
import test from "node:test";
import { WarroomQueue, WARROOM_QUEUE_MAX, WARROOM_QUEUE_MAX_WAIT_MS } from "../src/warroomQueue.js";

test("admit starts immediately when the queue is empty and seats suffice", () => {
  const queue = new WarroomQueue<string>();
  assert.deepEqual(queue.admit(4, 7, 7), { kind: "start" });
  assert.deepEqual(queue.admit(4, 4, 7), { kind: "start" });
});

test("admit queues when seats are short, reporting how many are ahead", () => {
  const queue = new WarroomQueue<string>();
  assert.deepEqual(queue.admit(4, 3, 7), { kind: "queue", ahead: 0 });
  queue.enqueue("a", 4, "A", 0);
  assert.deepEqual(queue.admit(4, 3, 7), { kind: "queue", ahead: 1 });
});

test("a non-empty queue makes newcomers wait even if seats are free (no line jumping)", () => {
  const queue = new WarroomQueue<string>();
  queue.enqueue("a", 5, "A", 0);
  assert.deepEqual(queue.admit(3, 4, 7), { kind: "queue", ahead: 1 });
});

test("needs above the theoretical maximum are rejected instead of queued", () => {
  const queue = new WarroomQueue<string>();
  assert.deepEqual(queue.admit(8, 0, 7), { kind: "impossible" });
  assert.deepEqual(queue.admit(8, 8, 7), { kind: "impossible" });
  assert.equal(queue.size, 0);
});

test("queue cap: the (max+1)th waiting request is refused", () => {
  const queue = new WarroomQueue<string>();
  assert.equal(WARROOM_QUEUE_MAX, 3);
  for (let i = 0; i < WARROOM_QUEUE_MAX; i += 1) {
    const admission = queue.admit(4, 0, 7);
    assert.deepEqual(admission, { kind: "queue", ahead: i });
    assert.equal(queue.enqueue(`t${i}`, 4, `T${i}`, 0), i);
  }
  assert.deepEqual(queue.admit(4, 0, 7), { kind: "full" });
  // impossible 優先於 full：永遠等不到的需求要得到正確的原因
  assert.deepEqual(queue.admit(9, 0, 7), { kind: "impossible" });
});

test("next() is strict FIFO and never lets a smaller later request skip the head", () => {
  const queue = new WarroomQueue<string>();
  queue.enqueue("big", 5, "BIG", 0);
  queue.enqueue("small", 3, "SMALL", 0);
  let step = queue.next(4, 7, 1);
  assert.equal(step.start, null);
  assert.deepEqual(step.dropped, []);
  assert.equal(queue.size, 2);
  step = queue.next(5, 7, 2);
  assert.equal(step.start?.id, "big");
  assert.equal(queue.ahead("small"), 0);
  step = queue.next(0, 7, 3);
  assert.equal(step.start, null);
  step = queue.next(3, 7, 4);
  assert.equal(step.start?.payload, "SMALL");
  assert.equal(queue.size, 0);
});

test("queued requests hold no seats: next() only hands out what currently fits", () => {
  const queue = new WarroomQueue<string>();
  queue.enqueue("a", 4, "A", 0);
  queue.enqueue("b", 4, "B", 0);
  // 外層每開一場就拿最新剩餘席位再問一次
  let seats = 8;
  const started: string[] = [];
  for (;;) {
    const step = queue.next(seats, 7, 1);
    if (!step.start) break;
    started.push(step.start.id);
    seats -= step.start.seats;
  }
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(seats, 0);
});

test("cancel removes a waiting request and later positions move up", () => {
  const queue = new WarroomQueue<string>();
  queue.enqueue("a", 4, "A", 0);
  queue.enqueue("b", 4, "B", 0);
  queue.enqueue("c", 4, "C", 0);
  assert.equal(queue.ahead("c"), 2);
  assert.equal(queue.cancel("b")?.payload, "B");
  assert.equal(queue.ahead("c"), 1);
  assert.equal(queue.cancel("b"), null);
  assert.equal(queue.cancel("nope"), null);
  assert.equal(queue.ahead("b"), null);
  assert.deepEqual(queue.admit(4, 0, 7), { kind: "queue", ahead: 2 });
});

test("expired requests are dropped from anywhere in the line", () => {
  const queue = new WarroomQueue<string>(3, 1_000);
  queue.enqueue("old", 4, "OLD", 0);
  queue.enqueue("fresh", 4, "FRESH", 900);
  const step = queue.next(4, 7, 1_500);
  assert.deepEqual(step.dropped.map((d) => [d.item.id, d.reason]), [["old", "expired"]]);
  assert.equal(step.start?.id, "fresh");
  assert.equal(WARROOM_QUEUE_MAX_WAIT_MS, 30 * 60_000);
});

test("a head that became impossible (more resident NPCs) is dropped, the next one proceeds", () => {
  const queue = new WarroomQueue<string>();
  queue.enqueue("five", 5, "FIVE", 0);
  queue.enqueue("three", 3, "THREE", 0);
  const step = queue.next(4, 4, 1);
  assert.deepEqual(step.dropped.map((d) => [d.item.id, d.reason]), [["five", "impossible"]]);
  assert.equal(step.start?.id, "three");
});
