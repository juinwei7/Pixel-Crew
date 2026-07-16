import assert from "node:assert/strict";
import test from "node:test";
import {
  composePersonaPrompt,
  MAX_PERSONA_INSTRUCTIONS,
  MAX_PERSONA_ROLE,
  MAX_PERSONA_TEMPLATE_NAME,
  normalizePersona,
  normalizePersonaTemplate,
  parsePersona,
  serializePersona,
} from "../src/persona.js";

test("normalizePersona trims, caps, and collapses empty personas to null", () => {
  assert.deepEqual(normalizePersona({ role: "  QA  ", instructions: " test UI " }), { role: "QA", instructions: "test UI" });
  assert.equal(normalizePersona({ role: "", instructions: "   " }), null);
  assert.equal(normalizePersona(null), null);
  assert.equal(normalizePersona("nope"), null);

  const long = normalizePersona({ role: "x".repeat(200), instructions: "y".repeat(9000) });
  assert.equal(long?.role.length, MAX_PERSONA_ROLE);
  assert.equal(long?.instructions.length, MAX_PERSONA_INSTRUCTIONS);
});

test("composePersonaPrompt renders labelled sections and is empty for no persona", () => {
  assert.equal(composePersonaPrompt(null), "");
  assert.equal(composePersonaPrompt({ role: "QA 工程師", instructions: "" }), "【職務 / Role】QA 工程師");
  assert.equal(composePersonaPrompt({ role: "", instructions: "只講重點" }), "只講重點");
  assert.equal(
    composePersonaPrompt({ role: "QA", instructions: "只講重點" }),
    "【職務 / Role】QA\n\n只講重點",
  );
});

test("serialize/parse persona round-trips and tolerates junk", () => {
  const persona = { role: "後端", instructions: "寫測試" };
  assert.deepEqual(parsePersona(serializePersona(persona)), persona);
  assert.equal(serializePersona(null), null);
  assert.equal(parsePersona(null), null);
  assert.equal(parsePersona("{not json"), null);
});

test("normalizePersonaTemplate requires content, defaults name to role, and preserves id", () => {
  assert.equal(normalizePersonaTemplate({ name: "只有名字" }), null);
  assert.equal(normalizePersonaTemplate({ role: "", instructions: "" }), null);

  const defaulted = normalizePersonaTemplate({ role: "QA 工程師", instructions: "測 UI" });
  assert.deepEqual(defaulted, { id: null, name: "QA 工程師", role: "QA 工程師", instructions: "測 UI" });

  const named = normalizePersonaTemplate({ id: "t1", name: "  嚴格審查員  ", role: "Reviewer", instructions: "挑毛病" });
  assert.deepEqual(named, { id: "t1", name: "嚴格審查員", role: "Reviewer", instructions: "挑毛病" });

  const capped = normalizePersonaTemplate({ name: "x".repeat(200), instructions: "y" });
  assert.equal(capped?.name.length, MAX_PERSONA_TEMPLATE_NAME);
});
