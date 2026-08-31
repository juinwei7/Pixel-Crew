import assert from "node:assert/strict";
import test from "node:test";
import { requiresAutoApproveConfirmation } from "../src/autoApproveSafety";

test("only entering unrestricted auto-approve requires explicit confirmation", () => {
  assert.equal(requiresAutoApproveConfirmation("off", "invincible"), true);
  assert.equal(requiresAutoApproveConfirmation("safe", "invincible"), true);
  assert.equal(requiresAutoApproveConfirmation("full", "invincible"), true);
  assert.equal(requiresAutoApproveConfirmation("invincible", "invincible"), false);
});

test("more restrictive and ordinary mode changes stay immediate", () => {
  assert.equal(requiresAutoApproveConfirmation("invincible", "safe"), false);
  assert.equal(requiresAutoApproveConfirmation("invincible", "off"), false);
  assert.equal(requiresAutoApproveConfirmation("safe", "full"), false);
});
