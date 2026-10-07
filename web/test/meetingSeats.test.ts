import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MEETING_BACK_OY, MEETING_SEATS, meetingSeat } from "../src/game/meetingSeats";

const decorSrc = readFileSync(new URL("../src/game/officeDecor.ts", import.meta.url), "utf8");
const sceneSrc = readFileSync(new URL("../src/game/scene.ts", import.meta.url), "utf8");

test("war-room seats alternate front / back from the middle, so 2-3 people already sit across the table", () => {
  const rows = MEETING_SEATS.slice(0, 8).map((s) => s.row);
  assert.deepEqual(rows, ["front", "back", "front", "back", "front", "back", "front", "back"]);
  assert.deepEqual(MEETING_SEATS.slice(0, 2).map((s) => Math.abs(s.ox)), [11, 11]);
  assert.equal(new Set(MEETING_SEATS.slice(0, 3).map((s) => s.row)).size, 2);
});

test("every chair is used exactly once (4 front + 4 back), lined up with the drawn chairs", () => {
  const seatX = decorSrc.match(/const SEAT_X = \[([^\]]+)\]/);
  assert.ok(seatX);
  const chairs = seatX[1].split(",").map((v) => Number(v.trim())).sort((a, b) => a - b);
  for (const row of ["front", "back"] as const) {
    const xs = MEETING_SEATS.filter((s) => s.row === row).map((s) => s.ox).sort((a, b) => a - b);
    assert.deepEqual(xs, chairs, `${row} row`);
  }
  const keys = MEETING_SEATS.map((s) => `${s.ox},${s.oy}`);
  assert.equal(new Set(keys).size, keys.length, "no two seats overlap");
});

test("back row sits behind the table: torso above the far edge, legs hidden, in front of the drawn backrest", () => {
  // Meeting container at y 306, stand line at 320 (furnitureDefs meeting standY).
  const feet = 320 + MEETING_BACK_OY;
  const farEdge = 306 - 11; // table top back line
  const backrestTop = 306 - 17; // back-row chair backrest
  assert.ok(feet > farEdge && feet - farEdge <= 6, "legs (bottom ~5px of the sprite) tucked under the table top");
  assert.ok(feet - 8 <= backrestTop + 3, "shoulders around the backrest top");
  for (const s of MEETING_SEATS) if (s.row === "back") assert.equal(s.oy, MEETING_BACK_OY);
  for (const s of MEETING_SEATS) if (s.row === "front") assert.equal(s.oy, 0);
});

test("depth: the table sorts between the back row and the front row", () => {
  const z = decorSrc.match(/this\.meetingTable\.zIndex = 306 \+ (\d+);/);
  assert.ok(z);
  const tableZ = 306 + Number(z[1]);
  assert.ok(320 + MEETING_BACK_OY < tableZ, "back row behind the table");
  assert.ok(320 > tableZ, "front row in front of the table");
  assert.match(sceneSrc, /officeDecor\.meetingTable/);
  // Back-row chairs are drawn with the rug (under everyone), not with the table.
  assert.match(decorSrc, /const top = -17 \+ ny;/);
  assert.match(decorSrc, /rug\.rect\(x - 5, top \+ 1, 10, 5\)\.fill\(MEET\.chair\)/);
});

test("the war-room label and its plate hide while a debate is seated, and come back when idle", () => {
  assert.match(sceneSrc, /furniture\.setLabelHidden\("meeting", warRoomInSession\)/);
  assert.match(sceneSrc, /label\.text\.visible = !warRoomInSession/);
});

test("overflow seats stand clear of the table ends, and a full roundtable (lead + 4) gets chairs", () => {
  const half = Number(decorSrc.match(/tableHalf: (\d+)/)?.[1]);
  assert.ok(half > 0);
  const ends = MEETING_SEATS.filter((s) => s.row === "end");
  assert.equal(ends.length, 2);
  for (const s of ends) assert.ok(Math.abs(s.ox) > half + 4, "end seat beyond the table end");
  assert.ok(MEETING_SEATS.filter((s) => s.row !== "end").length >= 5);
});

test("meetingSeat wraps for very large crews", () => {
  assert.deepEqual(meetingSeat(MEETING_SEATS.length), MEETING_SEATS[0]);
  assert.deepEqual(meetingSeat(1), MEETING_SEATS[1]);
});
