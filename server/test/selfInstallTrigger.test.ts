// 自裝觸發器的回歸鎖：閘門只看得到已提交的 commit，而重建腳本 build 的是整個工作目錄——
// 所以工作目錄不乾淨就不能自裝，放行時也要把檢查過的 HEAD 交給重建腳本複驗。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeDirtyWorktree } from "../src/selfEvolveInstall.js";
import {
  AUTO_SELF_INSTALL_REGATE_MS, SELF_INSTALL_INFLIGHT_TIMEOUT_MS, describeSelfInstallInFlight, readRepoHead,
  shouldAutoGateSelfInstall, triggerSelfInstall,
} from "../src/selfInstallTrigger.js";

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
}

function withRepo(run: (repo: string, dataDirectory: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pc-self-install-"));
  const repo = join(root, "repo");
  const dataDirectory = join(root, "data");
  try {
    mkdirSync(join(repo, "scripts", "windows"), { recursive: true });
    mkdirSync(join(dataDirectory, "coldinstall"), { recursive: true });
    writeFileSync(join(dataDirectory, "coldinstall", "Pixel Crew.exe"), "staged");
    writeFileSync(join(dataDirectory, "coldinstall", "Pixel Crew.rollback.exe"), "rollback");
    writeFileSync(join(repo, "scripts", "windows", "pc-selfrebuild.ps1"), "# rebuild\n");
    writeFileSync(join(repo, ".gitignore"), ".pc-selfrebuild-launch.vbs\n");
    writeFileSync(join(repo, "notes.ts"), "export const n = 1;\n");
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    // fallback 範圍只看 HEAD 這一個 commit：放一個無害改動，讓閘門本身放行。
    writeFileSync(join(repo, "notes.ts"), "export const n = 2;\n");
    git(repo, "commit", "-q", "-am", "harmless");
    run(repo, dataDirectory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const silent = () => undefined;

test("a clean tree passes the gate and hands the checked HEAD to the rebuild script", () => {
  withRepo((repo, dataDirectory) => {
    const launched: string[] = [];
    const result = triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: (cmd) => launched.push(cmd) });
    assert.equal(result.outcome, "fired", JSON.stringify(result));
    assert.equal(launched.length, 1);
    assert.match(launched[0], new RegExp(`-ExpectedHead "${readRepoHead(repo)}"`));
  });
});

test("uncommitted or untracked changes block the install — the rebuild would ship them unchecked", () => {
  withRepo((repo, dataDirectory) => {
    const launched: string[] = [];
    const trigger = () => triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: (cmd) => launched.push(cmd) });

    writeFileSync(join(repo, "notes.ts"), "export const n = 3;\n");
    const modified = trigger();
    assert.equal(modified.outcome, "needs_owner");
    assert.match(modified.detail ?? "", /未提交/);

    git(repo, "checkout", "--", "notes.ts");
    writeFileSync(join(repo, "toolPolicy.ts"), "export const relaxed = true;\n");
    const untracked = trigger();
    assert.equal(untracked.outcome, "needs_owner");
    assert.match(untracked.detail ?? "", /toolPolicy\.ts/);

    assert.equal(launched.length, 0);
  });
});

test("a committed change to the trigger itself needs the owner", () => {
  withRepo((repo, dataDirectory) => {
    mkdirSync(join(repo, "server", "src"), { recursive: true });
    writeFileSync(join(repo, "server", "src", "selfInstallTrigger.ts"), "export {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "touch the trigger");
    const result = triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: () => assert.fail("must not launch") });
    assert.equal(result.outcome, "needs_owner");
  });
});

test("files git treats as binary are still scanned — .gitattributes can't hide a brake change", () => {
  withRepo((repo, dataDirectory) => {
    // 屬性在更早的 commit 就放進來（不在這次範圍內），之後的改動只剩內容比對擋得住。
    writeFileSync(join(repo, ".gitattributes"), "*.ts binary\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "attrs");
    writeFileSync(join(repo, "notes.ts"), "export const n = () => evaluateAutoApproval;\n");
    git(repo, "commit", "-q", "-am", "sneaky");
    const result = triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: () => assert.fail("must not launch") });
    assert.equal(result.outcome, "needs_owner", JSON.stringify(result));
    assert.match(result.detail ?? "", /核准/);
  });
});

test("a UTF-16 source file or a symlink can't slip past the keyword scan", () => {
  withRepo((repo, dataDirectory) => {
    writeFileSync(join(repo, "wide.ts"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("export const x = 1;\n", "utf16le")]));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "wide");
    const wide = triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: () => assert.fail("must not launch") });
    assert.equal(wide.outcome, "needs_owner", JSON.stringify(wide));
  });
  if (process.platform === "win32") return; // symlink 需要特權，Windows CI 不測這半
  withRepo((repo, dataDirectory) => {
    symlinkSync("/tmp/outside.ts", join(repo, "shim.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "link");
    const link = triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: () => assert.fail("must not launch") });
    assert.equal(link.outcome, "needs_owner", JSON.stringify(link));
  });
});

test("describeDirtyWorktree keeps the first path intact and is null for a clean tree", () => {
  assert.equal(describeDirtyWorktree(""), null);
  assert.equal(describeDirtyWorktree("\n"), null);
  const detail = describeDirtyWorktree(" M server/src/a.ts\n?? b.ts\n") ?? "";
  assert.match(detail, /2 個未提交/);
  assert.match(detail, /server\/src\/a\.ts, b\.ts/);
});

const stamp = (ms: number) => new Date(ms).toISOString();

test("in-flight: a fired rebuild locks out another trigger until its log shows it finished", () => {
  const t0 = Date.parse("2026-10-07T02:00:00Z");
  const base = { attemptAt: t0, rebuildLog: "", pendingFiredAt: null };
  assert.match(describeSelfInstallInFlight({ ...base, now: t0 + 30_000 }) ?? "", /重建還在跑/, "just launched, log not written yet");
  const running = `${stamp(t0 + 1_000)} === self-rebuild start (repo=x reason=manual) ===\n${stamp(t0 + 2_000)} run: npm test\n`;
  assert.ok(describeSelfInstallInFlight({ ...base, rebuildLog: running, now: t0 + 20 * 60_000 }));
  for (const end of ["FAILED: npm test (exit 1) -- abort, nothing installed", "no-op: new build identical to rollback point; nothing to ship", "FATAL: HEAD is 'x', gate reviewed 'y' -- abort, nothing installed"]) {
    assert.equal(describeSelfInstallInFlight({ ...base, rebuildLog: `${running}${stamp(t0 + 3_000)} ${end}\n`, now: t0 + 60_000 }), null, end);
  }
  // 收尾行若是上一次觸發留下的（早於這次 attemptAt），不能把這次放掉。
  assert.ok(describeSelfInstallInFlight({ ...base, rebuildLog: `${stamp(t0 - 60_000)} FAILED: old\n${running}`, now: t0 + 60_000 }));
  // 重建根本沒起來（log 一直沒有 start 行）不鎖死；行程死掉沒收尾也有逾時。
  assert.equal(describeSelfInstallInFlight({ ...base, now: t0 + 10 * 60_000 }), null);
  assert.equal(describeSelfInstallInFlight({ ...base, rebuildLog: running, now: t0 + SELF_INSTALL_INFLIGHT_TIMEOUT_MS }), null);
});

test("in-flight: a handed-off install stays locked until the boot resolver clears its marker", () => {
  const t0 = Date.parse("2026-10-07T02:00:00Z");
  const done = `${stamp(t0 + 1_000)} === self-rebuild start ===\n${stamp(t0 + 600_000)} === self-rebuild done; handed off to pc-selfinstall (WMI) ===\n`;
  const handedOff = { attemptAt: t0, rebuildLog: done, pendingFiredAt: t0 + 600_000 };
  assert.match(describeSelfInstallInFlight({ ...handedOff, now: t0 + 700_000 }) ?? "", /等驗收/);
  assert.equal(describeSelfInstallInFlight({ ...handedOff, pendingFiredAt: null, now: t0 + 700_000 }), null);
  assert.equal(describeSelfInstallInFlight({ ...handedOff, now: t0 + 600_000 + SELF_INSTALL_INFLIGHT_TIMEOUT_MS }), null, "stale marker");
});

test("the manual trigger honours the in-flight lock too", () => {
  withRepo((repo, dataDirectory) => {
    let clock = Date.parse("2026-10-07T02:00:00Z");
    const launched: string[] = [];
    const trigger = () => triggerSelfInstall({ repo, dataDirectory, reason: "manual", log: silent, launch: (cmd) => launched.push(cmd), now: () => clock });
    assert.equal(trigger().outcome, "fired");
    clock += 5_000;
    assert.equal(trigger().outcome, "in_flight");
    mkdirSync(join(dataDirectory, "logs"), { recursive: true });
    writeFileSync(join(dataDirectory, "logs", "self-rebuild.log"), `${stamp(clock)} === self-rebuild start ===\n${stamp(clock + 1_000)} FAILED: npm test (exit 1) -- abort, nothing installed\n`);
    clock += 10_000;
    assert.equal(trigger().outcome, "fired", "a finished (failed) rebuild releases the lock");
    clock += 5_000;
    writeFileSync(join(dataDirectory, "self-install-pending.json"), JSON.stringify({ firedAt: clock, stagedExe: "s", rollbackExe: "r" }));
    writeFileSync(join(dataDirectory, "logs", "self-rebuild.log"), `${stamp(clock - 1_000)} === self-rebuild done; handed off ===\n`);
    const waiting = trigger();
    assert.equal(waiting.outcome, "in_flight");
    assert.match(waiting.detail ?? "", /等驗收/);
    assert.equal(launched.length, 2);
  });
});

test("auto re-gate: the same HEAD is not re-checked every sweep", () => {
  const now = 1_000_000;
  assert.equal(shouldAutoGateSelfInstall(null, "h1", now), true);
  const memo = { head: "h1", outcome: "needs_owner", at: now };
  assert.equal(shouldAutoGateSelfInstall(memo, "h1", now + 15_000), false);
  assert.equal(shouldAutoGateSelfInstall(memo, "h2", now + 15_000), true, "a new commit is checked right away");
  assert.equal(shouldAutoGateSelfInstall(memo, "h1", now + AUTO_SELF_INSTALL_REGATE_MS), true, "transient blocks (dirty tree…) get another look later");
});
