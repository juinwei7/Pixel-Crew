import assert from "node:assert/strict";
import test from "node:test";
import {
  LAMP_LINGER_MS,
  MAX_PAPER_BALLS,
  TRINKETS,
  ZHENG_STROKES,
  dayKey,
  lampLit,
  noteHit,
  noteLayout,
  paperBalls,
  queueCard,
  tallyStrokes,
  trinketFor,
  trinketPixels,
} from "../src/game/deskProps";
import { spotEvent } from "../src/game/officeInteract";

test("desk trinket is stable per NPC id and spread over the set", () => {
  assert.equal(trinketFor("worker-a"), trinketFor("worker-a"));
  const seen = new Set(Array.from({ length: 64 }, (_, i) => trinketFor(`w${i}`)));
  assert.ok(seen.size >= 6, `only ${seen.size} kinds used`);
  for (const kind of TRINKETS) {
    for (const [x, y, w, h] of trinketPixels(kind)) {
      // On the right of the desk top, clear of the monitor (x<=7) and the sticky notes column, never below the desk surface.
      assert.ok(x >= 9 && x + w <= 14, `${kind} x out of slot`);
      assert.ok(y + h <= -5, `${kind} sinks into the desk`);
      assert.ok(y >= -12, `${kind} too tall`);
    }
  }
});

test("night lamp: dark by day, always on while working, out after a long idle", () => {
  assert.equal(lampLit(false, true, 0, 0), false);
  assert.equal(lampLit(true, true, null, 0), true);
  assert.equal(lampLit(true, false, null, 1_000), false, "never seen busy since load = dark");
  assert.equal(lampLit(true, false, 1_000, 1_000 + LAMP_LINGER_MS - 1), true);
  assert.equal(lampLit(true, false, 1_000, 1_000 + LAMP_LINGER_MS), false);
});

test("sticky notes: one per queued command, max three, longer queues stack", () => {
  assert.deepEqual(noteLayout(0), { notes: [], stacked: false });
  assert.equal(noteLayout(2).notes.length, 2);
  assert.equal(noteLayout(3).stacked, false);
  const long = noteLayout(9);
  assert.equal(long.notes.length, 3);
  assert.equal(long.stacked, true);
  // Notes stay small (3x2) and inside their hit box.
  for (const [x, y, w, h] of long.notes) {
    assert.equal(w * h, 6);
    assert.ok(noteHit(x, y, 9) && noteHit(x + w - 1, y + h - 1, 9));
  }
  assert.equal(noteHit(6, -18, 0), false, "no notes = no tap target");
  assert.equal(noteHit(-10, -2, 3), false);
});

test("queue card lists the first three commands, trimmed, plus a 'more' line", () => {
  const card = queueCard(["  fix   the\nbuild ", "b", "c", "d", "e"], 10);
  assert.deepEqual(card.lines, ["fix the b…", "b", "c"]);
  assert.ok(card.title.includes("5"));
  assert.ok(card.more?.includes("2"));
  assert.equal(queueCard(["only"]).more, null);
});

test("waste bin: one paper ball per failure, capped at the rim", () => {
  assert.equal(paperBalls(0).length, 0);
  assert.equal(paperBalls(2).length, 2);
  assert.equal(paperBalls(99).length, MAX_PAPER_BALLS);
  const slots = paperBalls(MAX_PAPER_BALLS);
  // Bottom-up fill: never a ball floating above an empty slot below it.
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i][1] <= slots[i - 1][1]);
  for (const [x, y, w, h] of slots) assert.ok(w <= 2 && h <= 2 && x >= 15 && x + w <= 19 && y >= 0);
});

test("whiteboard 正 tally: one stroke per completion, ×N past five 正", () => {
  assert.equal(tallyStrokes(0, 0, 0).length, 0);
  assert.equal(tallyStrokes(1, 0, 0).length, 1);
  assert.equal(tallyStrokes(7, 0, 0).length, 7);
  assert.equal(tallyStrokes(25, 0, 0).length, 25);
  // Every count up to 25 adds exactly the next stroke (so the board can write them in one by one).
  for (let n = 1; n <= 25; n++) {
    const prev = tallyStrokes(n - 1, 94, 26);
    const next = tallyStrokes(n, 94, 26);
    assert.deepEqual(next.slice(0, prev.length), prev);
  }
  // The first 正 is written in its real stroke order.
  assert.deepEqual(tallyStrokes(5, 0, 0), ZHENG_STROKES);
  // Past 25: 正 ×N, and it still fits the board strip (x 92..123, y 26..30).
  for (const n of [26, 31, 99, 500, 10_000]) {
    for (const [x, y, w, h] of tallyStrokes(n, 94, 26)) {
      assert.ok(x >= 92 && x + w <= 124 && y >= 26 && y + h <= 31, `count ${n} spills off the board`);
    }
  }
  assert.ok(tallyStrokes(26, 0, 0).length < tallyStrokes(25, 0, 0).length + 20);
});

test("daily counters roll over at local midnight", () => {
  assert.equal(dayKey(new Date(2026, 9, 6, 23, 59)), "2026-10-06");
  assert.equal(dayKey(new Date(2026, 9, 7, 0, 0)), "2026-10-07");
});

test("coffee machine tap maps to the coffee-machine scene event; other decor does not", () => {
  assert.equal(spotEvent("coffee"), "coffee-machine");
  assert.equal(spotEvent("clock"), null);
});
