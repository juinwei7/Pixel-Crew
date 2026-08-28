import assert from "node:assert/strict";
import test from "node:test";
import { SQUAD_TEMPLATES } from "../src/squads";

// 模板資料是一鍵成軍（POST /api/squads）的直接輸入，這裡驗證的規則對齊
// 伺服器端的驗證：成員 1-6、姓名必填且不重複（大小寫不敏感）、每位成員都要
// 有 persona（role/instructions）、leadIndex 落在範圍內、autoApprove 不含
// invincible。長度上限對齊伺服器的裁切（80 字姓名、80 字 role、4000 字
// instructions、80 字小隊名、200 字宗旨），確保資料不會被伺服器默默截斷。

test("template ids are unique and every template has display fields", () => {
  const ids = SQUAD_TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of SQUAD_TEMPLATES) {
    assert.ok(template.id, "id 必填");
    assert.ok(template.emoji, `${template.id}: emoji 必填`);
    assert.ok(template.name.trim(), `${template.id}: name 必填`);
    assert.ok(template.tagline.trim(), `${template.id}: tagline 必填`);
    assert.ok(template.firstOrder.trim(), `${template.id}: firstOrder 必填`);
  }
});

test("every template fits the server's 1-6 member window", () => {
  for (const template of SQUAD_TEMPLATES) {
    assert.ok(template.members.length >= 1 && template.members.length <= 6,
      `${template.id}: 成員數 ${template.members.length} 不在 1-6`);
  }
});

test("leadIndex points at an existing member", () => {
  for (const template of SQUAD_TEMPLATES) {
    assert.ok(Number.isInteger(template.leadIndex), `${template.id}: leadIndex 要是整數`);
    assert.ok(template.leadIndex >= 0 && template.leadIndex < template.members.length,
      `${template.id}: leadIndex ${template.leadIndex} 超出成員範圍`);
  }
});

test("member names are non-empty, unique within a template (case-insensitive), and within 80 chars", () => {
  for (const template of SQUAD_TEMPLATES) {
    const names = template.members.map((member) => member.name.trim().toLocaleLowerCase());
    assert.ok(names.every(Boolean), `${template.id}: 有成員缺姓名`);
    assert.equal(new Set(names).size, names.length, `${template.id}: 成員姓名重複`);
    for (const member of template.members) {
      assert.ok(member.name.length <= 80, `${template.id}/${member.name}: 姓名超過 80 字會被伺服器截斷`);
    }
  }
});

test("every member has a persona the server will accept (role + instructions within limits)", () => {
  for (const template of SQUAD_TEMPLATES) {
    for (const member of template.members) {
      assert.ok(member.role.trim(), `${template.id}/${member.name}: role 必填`);
      assert.ok(member.role.length <= 80, `${template.id}/${member.name}: role 超過 80 字`);
      assert.ok(member.instructions.trim(), `${template.id}/${member.name}: instructions 必填`);
      assert.ok(member.instructions.length <= 4000, `${template.id}/${member.name}: instructions 超過 4000 字`);
    }
  }
});

test("models and autoApprove stay within the template contract — no invincible via templates", () => {
  for (const template of SQUAD_TEMPLATES) {
    for (const member of template.members) {
      assert.ok(["opus", "sonnet", "haiku"].includes(member.model),
        `${template.id}/${member.name}: model ${member.model} 不是合法別名`);
      assert.ok(["off", "safe", "full"].includes(member.autoApprove),
        `${template.id}/${member.name}: autoApprove ${member.autoApprove} 不在 off/safe/full`);
    }
  }
});

test("purpose and name fit the server's clipping limits", () => {
  for (const template of SQUAD_TEMPLATES) {
    assert.ok(template.name.length <= 80, `${template.id}: 小隊名超過 80 字`);
    assert.ok(template.purpose.trim(), `${template.id}: purpose 必填`);
    assert.ok(template.purpose.length <= 200, `${template.id}: purpose 超過 200 字`);
  }
});
