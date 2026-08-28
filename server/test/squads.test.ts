import assert from "node:assert/strict";
import test from "node:test";
import {
  SQUAD_MAX_MEMBERS,
  SQUAD_MIN_MEMBERS,
  deriveSquadIdentity,
  normalizeSquadMember,
  parseSquadLeadIndex,
  parseSquadMembers,
  parseSquadProvider,
  validateSquadMembers,
  validateSquadSize,
} from "../src/squads.js";
import type { ProviderId } from "../src/providers/types.js";

const anyModel = (_provider: ProviderId, _model: string) => true;

test("parseSquadProvider only accepts codex; everything else is claude", () => {
  assert.equal(parseSquadProvider("codex"), "codex");
  assert.equal(parseSquadProvider("claude"), "claude");
  assert.equal(parseSquadProvider("gemini"), "claude");
  assert.equal(parseSquadProvider(undefined), "claude");
  assert.equal(parseSquadProvider(42), "claude");
});

test("parseSquadMembers treats non-arrays as empty", () => {
  assert.deepEqual(parseSquadMembers(undefined), []);
  assert.deepEqual(parseSquadMembers("nope"), []);
  assert.deepEqual(parseSquadMembers({ length: 3 }), []);
  const members = [{ name: "a" }];
  assert.equal(parseSquadMembers(members), members);
});

test("validateSquadSize enforces 1 to 6 members", () => {
  assert.equal(SQUAD_MIN_MEMBERS, 1);
  assert.equal(SQUAD_MAX_MEMBERS, 6);
  assert.equal(validateSquadSize([]), "小隊成員需為 1 到 6 位");
  assert.equal(validateSquadSize(new Array(7).fill({})), "小隊成員需為 1 到 6 位");
  assert.equal(validateSquadSize(new Array(1).fill({})), null);
  assert.equal(validateSquadSize(new Array(6).fill({})), null);
});

test("normalizeSquadMember merges role and instructions into a persona", () => {
  const member = normalizeSquadMember(
    { name: "  隊長  ", role: "領導", instructions: "帶隊", model: "sonnet", autoApprove: "safe" },
    "claude",
    anyModel,
  );
  assert.deepEqual(member, {
    name: "隊長",
    persona: { role: "領導", instructions: "帶隊" },
    model: "sonnet",
    autoApprove: "safe",
  });
});

test("normalizeSquadMember: missing role and instructions collapse the persona to null", () => {
  const member = normalizeSquadMember({ name: "無名" }, "claude", anyModel);
  assert.equal(member.persona, null);
});

test("normalizeSquadMember forces invincible (and any unknown value) to off", () => {
  for (const value of ["invincible", "yolo", true, 1, undefined]) {
    assert.equal(normalizeSquadMember({ name: "x", autoApprove: value }, "claude", anyModel).autoApprove, "off");
  }
  assert.equal(normalizeSquadMember({ name: "x", autoApprove: "full" }, "claude", anyModel).autoApprove, "full");
  assert.equal(normalizeSquadMember({ name: "x", autoApprove: "safe" }, "claude", anyModel).autoApprove, "safe");
});

test("normalizeSquadMember drops invalid or non-string models via the injected validator", () => {
  const strict = (_p: ProviderId, model: string) => model === "sonnet";
  assert.equal(normalizeSquadMember({ name: "x", model: "sonnet" }, "claude", strict).model, "sonnet");
  assert.equal(normalizeSquadMember({ name: "x", model: "bogus!" }, "claude", strict).model, undefined);
  assert.equal(normalizeSquadMember({ name: "x", model: 5 }, "claude", strict).model, undefined);
  assert.equal(normalizeSquadMember({ name: "x", model: "" }, "claude", strict).model, undefined);
});

test("normalizeSquadMember tolerates non-object candidates", () => {
  assert.deepEqual(normalizeSquadMember(null, "claude", anyModel), {
    name: "", persona: null, model: undefined, autoApprove: "off",
  });
  assert.deepEqual(normalizeSquadMember("junk", "claude", anyModel).name, "");
});

const member = (name: string) => ({
  name,
  persona: { role: "r", instructions: "i" },
  model: undefined,
  autoApprove: "off" as const,
});

test("validateSquadMembers passes a clean roster", () => {
  assert.equal(validateSquadMembers([member("甲"), member("乙")], ["現有NPC"]), null);
});

test("validateSquadMembers rejects a member without a name or persona", () => {
  const error = "請確認每位隊員都有不重複的姓名與職責（可能與現有 NPC 同名）";
  assert.equal(validateSquadMembers([member("")], []), error);
  assert.equal(validateSquadMembers([{ ...member("甲"), persona: null }], []), error);
});

test("validateSquadMembers rejects duplicate names within the squad (case-insensitive)", () => {
  const error = "請確認每位隊員都有不重複的姓名與職責（可能與現有 NPC 同名）";
  assert.equal(validateSquadMembers([member("Dev"), member("dev")], []), error);
});

test("validateSquadMembers rejects names clashing with existing workers (case-insensitive)", () => {
  const error = "請確認每位隊員都有不重複的姓名與職責（可能與現有 NPC 同名）";
  assert.equal(validateSquadMembers([member("一號機")], ["一號機"]), error);
  assert.equal(validateSquadMembers([member("DEV")], ["dev"]), error);
  assert.equal(validateSquadMembers([member("新人")], ["一號機"]), null);
});

test("parseSquadLeadIndex defaults to 0 and rejects out-of-range or fractional values", () => {
  assert.equal(parseSquadLeadIndex(undefined, 3), 0);
  assert.equal(parseSquadLeadIndex(2, 3), 2);
  assert.equal(parseSquadLeadIndex(3, 3), null);
  assert.equal(parseSquadLeadIndex(-1, 3), null);
  assert.equal(parseSquadLeadIndex(1.5, 3), null);
  assert.equal(parseSquadLeadIndex("abc", 3), null);
  assert.equal(parseSquadLeadIndex("1", 3), 1); // Number("1") 是整數，維持原行為
});

test("deriveSquadIdentity uses the squad name, falling back to the purpose", () => {
  assert.deepEqual(deriveSquadIdentity(" 獵蟲小隊 ", "追蹤並修復 bug"), {
    squadName: "獵蟲小隊",
    purpose: "追蹤並修復 bug",
    departmentName: "獵蟲小隊",
  });
  assert.deepEqual(deriveSquadIdentity("", "追蹤並修復 bug"), {
    squadName: "",
    purpose: "追蹤並修復 bug",
    departmentName: "追蹤並修復 bug小隊",
  });
  // 名稱與宗旨都空：宗旨落到「模板小隊」，部門名跟著變成「模板小隊小隊」（維持原行為）
  assert.deepEqual(deriveSquadIdentity("", ""), {
    squadName: "",
    purpose: "模板小隊",
    departmentName: "模板小隊小隊",
  });
  // 超長宗旨：部門名只取前 20 字
  const longPurpose = "超".repeat(30);
  assert.equal(deriveSquadIdentity("", longPurpose).departmentName, `${"超".repeat(20)}小隊`);
});
