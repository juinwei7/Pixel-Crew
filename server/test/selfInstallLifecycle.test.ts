// 回滾點生命週期測試：守住「回滾永遠回到上一個好版、不倒退、不救不回」這條不可逆正確性。
import assert from "node:assert/strict";
import test from "node:test";
import { checkRollbackReady, planPromoteOnSuccess, planRollbackRestore } from "../src/selfInstallLifecycle.js";

test("開火前閘門：就緒（staged 在、rollback 在、兩者不同）→ ready", () => {
  const r = checkRollbackReady({ stagedExists: true, rollbackExists: true, rollbackSameAsStaged: false });
  assert.equal(r.ready, true);
});

test("開火前閘門：無 staged → 擋", () => {
  assert.equal(checkRollbackReady({ stagedExists: false, rollbackExists: true, rollbackSameAsStaged: false }).ready, false);
});

test("開火前閘門：無 rollback → 擋（失敗救不回）", () => {
  const r = checkRollbackReady({ stagedExists: true, rollbackExists: false, rollbackSameAsStaged: false });
  assert.equal(r.ready, false);
  assert.match(r.reason, /救不回|無回滾點/);
});

test("開火前閘門：rollback＝新版 → 擋（就是那個倒退/救不回的致命坑）", () => {
  const r = checkRollbackReady({ stagedExists: true, rollbackExists: true, rollbackSameAsStaged: true });
  assert.equal(r.ready, false);
  assert.match(r.reason, /回不到上一個好版|倒退|救不回/);
});

test("成功才晉升：rollback := staged（這次成功的版本）", () => {
  assert.deepEqual(planPromoteOnSuccess({ staged: "S", rollback: "R" }), [{ op: "copy", from: "S", to: "R" }]);
});

test("失敗才還原：staged := rollback（上一個好版）", () => {
  assert.deepEqual(planRollbackRestore({ staged: "S", rollback: "R" }), [{ op: "copy", from: "R", to: "S" }]);
});
