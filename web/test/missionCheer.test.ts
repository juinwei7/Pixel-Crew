import assert from "node:assert/strict";
import test from "node:test";
import { missionCheers, type MissionCheerInput } from "../src/game/missionCheer";

const crew = (completed: number | null, total = 3): MissionCheerInput[] => [
  { id: "a", temporary: false, departmentKey: "dept", missionProgress: completed === null ? null : { completed, total } },
  { id: "b", temporary: false, departmentKey: "dept", missionProgress: completed === null ? null : { completed, total } },
  { id: "sub", temporary: true, departmentKey: "dept", missionProgress: null },
  { id: "x", temporary: false, departmentKey: "other", missionProgress: null },
];

test("missionCheers: stays quiet the first time a mission is seen (page load / reconnect)", () => {
  const { seen, cheers } = missionCheers(new Map(), crew(2));
  assert.deepEqual(cheers, []);
  assert.equal(seen.get("dept"), 2);
});

test("missionCheers: a completed step cheers the whole department (not sub-agents or other rooms)", () => {
  const first = missionCheers(new Map(), crew(0));
  const { cheers } = missionCheers(first.seen, crew(1));
  assert.deepEqual(cheers, [{ key: "dept", kind: "step", ids: ["a", "b"] }]);
});

test("missionCheers: the last step is the big one", () => {
  const first = missionCheers(new Map(), crew(2));
  assert.equal(missionCheers(first.seen, crew(3)).cheers[0]?.kind, "done");
});

test("missionCheers: no change, or a mission ending and a new one starting, does not cheer", () => {
  const first = missionCheers(new Map(), crew(1));
  assert.deepEqual(missionCheers(first.seen, crew(1)).cheers, []);
  const ended = missionCheers(first.seen, crew(null));
  assert.equal(ended.seen.has("dept"), false);
  assert.deepEqual(missionCheers(ended.seen, crew(2)).cheers, []);
});
