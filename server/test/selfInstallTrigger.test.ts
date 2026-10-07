// 自裝觸發器的回歸鎖：閘門只看得到已提交的 commit，而重建腳本 build 的是整個工作目錄——
// 所以工作目錄不乾淨就不能自裝，放行時也要把檢查過的 HEAD 交給重建腳本複驗。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeDirtyWorktree } from "../src/selfEvolveInstall.js";
import { readRepoHead, triggerSelfInstall } from "../src/selfInstallTrigger.js";

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

test("describeDirtyWorktree keeps the first path intact and is null for a clean tree", () => {
  assert.equal(describeDirtyWorktree(""), null);
  assert.equal(describeDirtyWorktree("\n"), null);
  const detail = describeDirtyWorktree(" M server/src/a.ts\n?? b.ts\n") ?? "";
  assert.match(detail, /2 個未提交/);
  assert.match(detail, /server\/src\/a\.ts, b\.ts/);
});
