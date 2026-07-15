import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowDocument, updateWorkflowDocument } from "../src/workflowDocument";

test("updates structured fields without dropping unknown YAML or body", () => {
  const original = `---
description: Old
custom:
  owner: crew
---

Keep this body.`;
  const updated = updateWorkflowDocument(original, { description: "New", "argument-hint": "[branch]" });
  const parsed = parseWorkflowDocument(updated);
  assert.equal(parsed.attributes.description, "New");
  assert.equal(parsed.attributes["argument-hint"], "[branch]");
  assert.deepEqual(parsed.attributes.custom, { owner: "crew" });
  assert.equal(parsed.body, "Keep this body.");
});

test("reports invalid YAML so raw mode can repair it", () => {
  assert.match(parseWorkflowDocument("---\ndescription: [broken\n---\nbody").error ?? "", /flow sequence|flow collection/i);
});
