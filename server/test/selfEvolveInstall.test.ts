// Stage 3 安全核心測試：用假 effects 驗整條「自裝→失敗自動回滾」流程被測死。
// 這是讓「系統自己動實機」不出事的命根——流程順序、critical 擋下、回滾觸發、回滾再失敗都要對。
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSelfInstallGate,
  evaluatePostInstall,
  runSelfInstall,
  type PostInstallChecks,
  type SelfInstallEffects,
  type SelfInstallStage,
} from "../src/selfEvolveInstall.js";

const GREEN = { buildOk: true, testsOk: true, packageOk: true };
const allChecks = (o: Partial<PostInstallChecks> = {}): PostInstallChecks => ({
  exeFresh: true, swappedOk: true, distHasNewCode: true, apiOk: true, healthOk: true, ...o,
});

// 記錄 effects 呼叫順序的假實作。
function makeFx(checks: PostInstallChecks, opts: { rollbackThrows?: boolean } = {}) {
  const calls: string[] = [];
  const stages: SelfInstallStage[] = [];
  const fx: SelfInstallEffects = {
    async snapshot() { calls.push("snapshot"); },
    async install() { calls.push("install"); },
    async collectChecks() { calls.push("collectChecks"); return checks; },
    async rollback() { calls.push("rollback"); if (opts.rollbackThrows) throw new Error("rollback boom"); },
    report(stage) { stages.push(stage); },
  };
  return { fx, calls, stages };
}

// ── 閘門純函式 ──────────────────────────────────────────────────────────────
test("閘門：動到保護機制(critical) → needs_owner、不放行", () => {
  const r = evaluateSelfInstallGate({ changedFiles: ["server/src/toolPolicy.ts"], ...GREEN });
  assert.equal(r.proceed, false);
  assert.equal(r.proceed === false && r.stop, "needs_owner");
});

test("閘門：非 critical 但驗證沒全綠 → preverify_failed", () => {
  const r = evaluateSelfInstallGate({ changedFiles: ["server/src/foo.ts"], buildOk: true, testsOk: false, packageOk: true });
  assert.equal(r.proceed, false);
  assert.equal(r.proceed === false && r.stop, "preverify_failed");
  assert.match(r.proceed === false ? r.reason : "", /tests/);
});

test("閘門：非 critical 且全綠 → 放行", () => {
  assert.equal(evaluateSelfInstallGate({ changedFiles: ["server/src/foo.ts"], ...GREEN }).proceed, true);
});

// ── 裝後健康純函式 ──────────────────────────────────────────────────────────
test("裝後：四件套＋健康全過 → healthy、不回滾", () => {
  const r = evaluatePostInstall(allChecks());
  assert.equal(r.healthy, true);
  assert.equal(r.mustRollback, false);
});

test("裝後：任一不過 → mustRollback 且列出失敗項", () => {
  const r = evaluatePostInstall(allChecks({ apiOk: false, swappedOk: false }));
  assert.equal(r.healthy, false);
  assert.equal(r.mustRollback, true);
  assert.deepEqual(r.failed.sort(), ["SWAPPED-OK", "api-200"].sort());
});

// ── 主流程（假 effects）──────────────────────────────────────────────────────
test("主流程：critical → needs_owner，不 snapshot 不 install", async () => {
  const { fx, calls } = makeFx(allChecks());
  const out = await runSelfInstall({ changedFiles: ["coldinstall/app.exe"], ...GREEN }, fx);
  assert.equal(out.outcome, "needs_owner");
  assert.deepEqual(calls, []); // 完全不動實機
});

test("主流程：全綠健康 → installed，順序正確且不回滾", async () => {
  const { fx, calls } = makeFx(allChecks());
  const out = await runSelfInstall({ changedFiles: ["server/src/foo.ts"], ...GREEN }, fx);
  assert.equal(out.outcome, "installed");
  assert.deepEqual(calls, ["snapshot", "install", "collectChecks"]);
});

test("主流程：裝後不健康 → 自動回滾(rolled_back)，snapshot 先於 install、rollback 在最後", async () => {
  const { fx, calls } = makeFx(allChecks({ apiOk: false }));
  const out = await runSelfInstall({ changedFiles: ["server/src/foo.ts"], ...GREEN }, fx);
  assert.equal(out.outcome, "rolled_back");
  assert.equal(out.outcome === "rolled_back" && out.failed.includes("api-200"), true);
  assert.deepEqual(calls, ["snapshot", "install", "collectChecks", "rollback"]);
});

test("主流程：回滾本身再失敗 → rollback_failed，誠實喊出最壞情況", async () => {
  const { fx } = makeFx(allChecks({ healthOk: false }), { rollbackThrows: true });
  const out = await runSelfInstall({ changedFiles: ["server/src/foo.ts"], ...GREEN }, fx);
  assert.equal(out.outcome, "rollback_failed");
  assert.equal(out.outcome === "rollback_failed" && /rollback boom/.test(out.error), true);
});

test("主流程：preverify 沒綠 → preverify_failed，不動實機", async () => {
  const { fx, calls } = makeFx(allChecks());
  const out = await runSelfInstall({ changedFiles: ["server/src/foo.ts"], buildOk: false, testsOk: true, packageOk: true }, fx);
  assert.equal(out.outcome, "preverify_failed");
  assert.deepEqual(calls, []);
});
