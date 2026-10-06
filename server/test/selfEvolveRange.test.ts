// 自裝閘門兩個洞的回歸鎖（2026-10 實際發生）：
// 洞1 搭便車：只看 HEAD~1..HEAD，被擋的 4135377 後面接無害的 8fca510 就一起上線 → 範圍改「上次上線..HEAD」逐 commit 過閘。
// 洞2 誤擋：README 內文寫到「循環 STOP／不可逆」就被判 critical → 純文件檔 diff 內容不比對，程式檔照舊。
import assert from "node:assert/strict";
import test from "node:test";
import { classifySelfChange, isPureDocFile, stripDocOnlyDiffSections } from "../src/selfEvolveSafety.js";
import { classifySelfChangeCommits, describeSelfChangeRangeBlock, resolveSelfInstallRange } from "../src/selfEvolveInstall.js";

const section = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n ctx\n${body}\n`;

// ───── 洞2：純文件 ─────

test("只改 .md 且內文含 STOP／不可逆／回滾／NEVER PRESUME CONSENT → 不擋", () => {
  const diff =
    section("README.md", "+- 自動循環：STOP only for what you genuinely cannot settle；花錢／不可逆一律問 owner\n+- 失敗自動回滾 rollback") +
    section("CHANGELOG.md", "+- NEVER PRESUME CONSENT 守則說明；allowSafeShell 文件\n-- 舊說明 四件套");
  const r = classifySelfChange(["README.md", "CHANGELOG.md"], diff);
  assert.equal(r.critical, false, JSON.stringify(r.hits));
});

test("非 ASCII 檔名被 git 加引號的 .md 也認得是文件", () => {
  const diff = `diff --git "a/README-\\345\\246\\202.md" "b/README-\\345\\246\\202.md"\n--- "a/README-\\345\\246\\202.md"\n+++ "b/README-\\345\\246\\202.md"\n@@ -1 +1 @@\n-x\n+花錢不可逆守則\n`;
  assert.equal(classifySelfChange(["README-如.md"], diff).critical, false);
  const spaced = `diff --git a/docs/my notes.md b/docs/my notes.md\n--- a/docs/my notes.md\n+++ b/docs/my notes.md\n@@ -1 +1 @@\n-x\n+rollback 說明\n`;
  assert.equal(classifySelfChange(["docs/my notes.md"], spaced).critical, false);
});

test("程式檔含關鍵字照擋（同一個 diff 裡混 .md 也一樣）", () => {
  const diff =
    section("README.md", "+STOP 說明（文件，不擋）") +
    section("server/src/workerAutopilot.ts", "-  // STOP only for what you genuinely cannot settle\n+  // relaxed");
  const r = classifySelfChange(["README.md", "server/src/workerAutopilot.ts"], diff);
  assert.equal(r.critical, true);
  for (const p of ["scripts/windows/foo.ps1", "scripts/build.mjs", "server/src/x.js", "notes.txt", "data.json"]) {
    assert.equal(classifySelfChange([p], section(p, "+ skip rollback")).critical, true, `應擋：${p}`);
  }
});

test("代理指令類 .md（CLAUDE.md、SKILL.md、.claude/、prompts/）內容照掃", () => {
  for (const p of ["CLAUDE.md", "server/AGENTS.md", "skills/x/SKILL.md", ".claude/agents/a.md", "server/prompts/autopilot.md"]) {
    assert.equal(isPureDocFile(p), false, p);
    assert.equal(classifySelfChange([p], section(p, "- NEVER PRESUME CONSENT")).critical, true, `應擋：${p}`);
  }
  assert.equal(isPureDocFile("README.md"), true);
  assert.equal(isPureDocFile("docs\\guide.MD"), true);
});

test("改名 .ts → .md 不豁免；檔名規則對 .md 仍有效；非 unified diff 仍整段掃", () => {
  const rename = "diff --git a/server/src/a.ts b/docs/a.md\n--- a/server/src/a.ts\n+++ b/docs/a.md\n@@ -1 +1 @@\n-const x = rollback();\n+gone\n";
  assert.equal(classifySelfChange(["server/src/a.ts", "docs/a.md"], rename).critical, true);
  assert.equal(stripDocOnlyDiffSections("+ 不可逆"), "+ 不可逆");
  assert.equal(classifySelfChange(["README.md"], "+ 不可逆").critical, true);
});

// ───── 洞1：範圍 ─────

test("範圍：有上線紀錄且是祖先 → since_shipped；等於 HEAD → up_to_date", () => {
  assert.deepEqual(resolveSelfInstallRange({ head: "h", lastShipped: "s", lastShippedIsAncestor: true, trigger: "auto" }), { kind: "since_shipped", base: "s", head: "h" });
  assert.equal(resolveSelfInstallRange({ head: "h", lastShipped: "h", lastShippedIsAncestor: true, trigger: "auto" }).kind, "up_to_date");
});

test("範圍：沒紀錄／不是祖先 → 退回 HEAD~1，自動觸發回 owner、手動放行但標明", () => {
  for (const [lastShipped, anc] of [["", false], ["s", false]] as const) {
    const auto = resolveSelfInstallRange({ head: "h", lastShipped, lastShippedIsAncestor: anc, trigger: "auto" });
    assert.equal(auto.kind, "fallback_last_commit");
    assert.equal(auto.kind === "fallback_last_commit" && auto.blockAsNeedsOwner, true);
    const manual = resolveSelfInstallRange({ head: "h", lastShipped, lastShippedIsAncestor: anc, trigger: "manual" });
    assert.equal(manual.kind === "fallback_last_commit" && manual.blockAsNeedsOwner, false);
    assert.ok(manual.kind === "fallback_last_commit" && manual.reason.length > 0);
  }
});

test("範圍內任一 commit 有 critical 就擋（被擋的不能搭無害 commit 的便車）", () => {
  const blocked = { commit: "aaaaaaa1", changedFiles: ["server/src/toolPolicy.ts"], diffText: section("server/src/toolPolicy.ts", "+x") };
  const harmless = { commit: "bbbbbbb2", changedFiles: ["web/src/a.tsx"], diffText: section("web/src/a.tsx", "+const a = 2;") };
  const r = classifySelfChangeCommits([blocked, harmless]);
  assert.equal(r.critical, true);
  assert.deepEqual(r.checked, ["aaaaaaa1", "bbbbbbb2"]);
  assert.deepEqual(r.criticalCommits, ["aaaaaaa1"]);
  assert.match(describeSelfChangeRangeBlock(r), /aaaaaaa/);
  // 內容關鍵字在較早 commit 也一樣擋
  const sneaky = { commit: "ccccccc3", changedFiles: ["server/src/workerAutopilot.ts"], diffText: section("server/src/workerAutopilot.ts", "- NEVER PRESUME CONSENT") };
  assert.equal(classifySelfChangeCommits([sneaky, harmless]).critical, true);
  // 全無害 → 放行
  const ok = classifySelfChangeCommits([harmless]);
  assert.equal(ok.critical, false);
  assert.equal(describeSelfChangeRangeBlock(ok), "");
});

test("重現 4135377+8fca510：文件 commit 不誤擋、兩個都有檢查到", () => {
  const docs = { commit: "4135377", changedFiles: ["README.md", "CHANGELOG.md"], diffText: section("README.md", "+循環 STOP；花錢／不可逆守則") };
  const fix = { commit: "8fca510", changedFiles: ["server/src/warRoom.ts"], diffText: section("server/src/warRoom.ts", "+const rounds = 1;") };
  const r = classifySelfChangeCommits([docs, fix]);
  assert.equal(r.critical, false);
  assert.deepEqual(r.checked, ["4135377", "8fca510"]);
});
