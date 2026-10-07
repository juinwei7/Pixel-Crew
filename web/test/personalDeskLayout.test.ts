import assert from "node:assert/strict";
import test from "node:test";
import { departmentDeskLayout, type PersonalDeskState } from "../src/game/personalDesks";

function member(id: string, departmentKey: string, ephemeral = false): PersonalDeskState {
  return {
    id,
    name: id,
    colorIndex: 0,
    active: false,
    workspacePath: "c:/ws",
    departmentKey,
    workspaceLabel: departmentKey,
    collaborationPhase: null,
    missionProgress: null,
    ephemeral,
  };
}

test("boss-task (ephemeral) departments are tagged as boss rooms; standing crew are not", () => {
  const layout = departmentDeskLayout([
    member("a1", "crew"),
    member("a2", "crew"),
    member("b1", "boss-dept", true),
    member("b2", "boss-dept", true),
  ]);
  const crew = layout.departments.find((d) => d.workspacePath === "crew");
  const boss = layout.departments.find((d) => d.workspacePath === "boss-dept");
  assert.ok(crew && boss);
  assert.equal(crew.boss, false);
  assert.equal(boss.boss, true);
  // A ≥2-member ephemeral group is still a "department" kind (drives the walled render + bench).
  assert.equal(boss.kind, "department");
});

test("a boss room never shares a row with the standing crew — it opens its own row below", () => {
  const layout = departmentDeskLayout([
    member("a1", "crew"),
    member("b1", "boss-dept", true),
    member("b2", "boss-dept", true),
  ]);
  const crewRow = layout.seats.get("a1")!.row;
  const bossRow1 = layout.seats.get("b1")!.row;
  const bossRow2 = layout.seats.get("b2")!.row;
  // Boss seats live on the same (own) row, strictly below the crew row.
  assert.equal(bossRow1, bossRow2);
  assert.ok(bossRow1 > crewRow, `boss row ${bossRow1} should be below crew row ${crewRow}`);
});

test("with no boss tasks the layout is unchanged (single crew row, no boss zones)", () => {
  const layout = departmentDeskLayout([member("a1", "crew"), member("a2", "crew")]);
  assert.equal(layout.departments.length, 1);
  assert.equal(layout.departments[0].boss, false);
  assert.equal(layout.seats.get("a1")!.row, 0);
  assert.equal(layout.seats.get("a2")!.row, 0);
});
