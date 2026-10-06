import assert from "node:assert/strict";
import test from "node:test";
import { followWarroomTicket, type WarroomTicketView } from "../src/warroomQueue";

function harness(views: Array<WarroomTicketView<string> | Error>, extra: { cancelAfter?: number } = {}) {
  let clock = 0;
  let calls = 0;
  const events: string[] = [];
  const fetchTicket = async () => {
    const next = views[Math.min(calls, views.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const options = {
    onQueued: (ahead: number) => events.push(`queued:${ahead}`),
    onRunning: () => events.push("running"),
    isCancelled: () => extra.cancelAfter !== undefined && calls >= extra.cancelAfter,
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    timeoutMessage: "timeout",
  };
  return { fetchTicket, options, events, calls: () => calls, clock: () => clock };
}

test("reports queue position, then start, then the verdict", async () => {
  const h = harness([
    { state: "queued", ahead: 1 },
    { state: "queued", ahead: 0 },
    { state: "running" },
    { state: "running" },
    { state: "done", result: "verdict" },
  ]);
  const outcome = await followWarroomTicket(h.fetchTicket, h.options);
  assert.deepEqual(outcome, { kind: "done", result: "verdict" });
  assert.deepEqual(h.events, ["queued:1", "queued:0", "running"]); // running 只通知一次
});

test("server-side failure and cancellation are surfaced", async () => {
  const failed = harness([{ state: "queued", ahead: 0 }, { state: "failed", error: "expired" }]);
  assert.deepEqual(await followWarroomTicket(failed.fetchTicket, failed.options), { kind: "failed", error: "expired" });
  const cancelled = harness([{ state: "cancelled", error: "x" }]);
  assert.deepEqual(await followWarroomTicket(cancelled.fetchTicket, cancelled.options), { kind: "cancelled" });
});

test("a local cancel stops polling right away", async () => {
  const h = harness([{ state: "queued", ahead: 2 }], { cancelAfter: 2 });
  assert.deepEqual(await followWarroomTicket(h.fetchTicket, h.options), { kind: "cancelled" });
  assert.equal(h.calls(), 2);
});

test("404 (server restarted, ticket gone) fails immediately; transient errors are retried", async () => {
  const gone = Object.assign(new Error("not found"), { status: 404 });
  const h404 = harness([gone]);
  assert.deepEqual(await followWarroomTicket(h404.fetchTicket, h404.options), { kind: "failed", error: "not found" });
  assert.equal(h404.calls(), 1);

  const flaky = Object.assign(new Error("offline"), { status: 0 });
  const hFlaky = harness([flaky, flaky, { state: "done", result: "ok" }]);
  assert.deepEqual(await followWarroomTicket(hFlaky.fetchTicket, hFlaky.options), { kind: "done", result: "ok" });

  const hDown = harness([flaky]);
  assert.deepEqual(await followWarroomTicket(hDown.fetchTicket, { ...hDown.options, maxConsecutiveErrors: 3 }), { kind: "failed", error: "offline" });
  assert.equal(hDown.calls(), 3);
});

test("gives up after the overall deadline", async () => {
  const h = harness([{ state: "queued", ahead: 0 }]);
  const outcome = await followWarroomTicket(h.fetchTicket, { ...h.options, deadlineMs: 10_000, intervalMs: 3_000 });
  assert.deepEqual(outcome, { kind: "failed", error: "timeout" });
  assert.ok(h.clock() >= 9_000);
});
