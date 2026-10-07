// 自我進化安全網不變量（階段 2）測試：證明「動到剎車＝critical＝回 owner」，
// 「只動非安全部分＝可自裝」，且不變量保守（寧可多攔）。這是讓自部署不變自毀的命根。
import assert from "node:assert/strict";
import test from "node:test";
import { classifySelfChange, describeSelfChangeBlock, findUnscannableDiffFiles } from "../src/selfEvolveSafety.js";

test("動到保護機制檔案 → critical（不看內容）", () => {
  for (const f of [
    "server/src/toolPolicy.ts",
    "server/src/dangerousCommand.ts",
    "server/src/bashWriteFence.ts",
    "server/src/selfEvolveSafety.ts",
    "coldinstall/pixel-crew/app.exe",
    "scripts/windows/pc-coldinstall.ps1",
    "scripts/windows/package-app.mjs",
    "server/src/selfEvolveInstall.ts",
    "server/src/selfEvolvePending.ts",
    "server/src/selfInstallLifecycle.ts",
    "server/src/selfInstallTrigger.ts",
    "scripts/windows/pc-selfrebuild.ps1",
    "scripts/windows/pc-selfinstall.ps1",
    "server/src/localAccess.ts",
    "_tsproxy.mjs",
    "windows/PixelCrewController/Program.cs",
    ".gitattributes",
    "server/.gitattributes",
  ]) {
    const r = classifySelfChange([f]);
    assert.equal(r.critical, true, `應 critical：${f}`);
    assert.ok(r.hits.length >= 1);
  }
});

test("Windows 反斜線路徑也認得", () => {
  assert.equal(classifySelfChange(["server\\src\\toolPolicy.ts"]).critical, true);
});

test("只動非安全部分 → 非 critical（可在閘門綠後自裝）", () => {
  const r = classifySelfChange([
    "server/src/npcNameplate.ts",
    "web/src/components/ActivityBadge.tsx",
    "server/src/openRequests.ts",
  ]);
  assert.equal(r.critical, false);
  assert.deepEqual(r.hits, []);
});

test("合法演進檔(workerAutopilot/index) 但 diff 觸及剎車關鍵字 → critical", () => {
  const changed = ["server/src/workerAutopilot.ts"];
  // 沒有安全關鍵字的 diff：只改計畫顯示 → 非 critical
  assert.equal(classifySelfChange(changed, "+ planBlock tweak: show updatedRound").critical, false);
  // 動到 STOP／同意規則 → critical
  assert.equal(classifySelfChange(changed, "- NEVER PRESUME CONSENT FOR MONEY\n+ (relaxed)").critical, true);
  assert.equal(classifySelfChange(changed, "+ if (allowSafeShell) allowEverything()").critical, true);
  assert.equal(classifySelfChange(changed, "- 回滾\n+ skip rollback").critical, true);
});

test("unified diff 只看改動行：上下文行剛好含剎車字眼不誤判，真的增刪照攔", () => {
  const changed = ["web/src/components/TopBar.tsx"];
  const header = "diff --git a/web/src/components/TopBar.tsx b/web/src/components/TopBar.tsx\n--- a/web/src/components/TopBar.tsx\n+++ b/web/src/components/TopBar.tsx\n@@ -10,3 +10,3 @@\n";
  // 2026-10 實際誤判：上下文舊註解「失敗回滾」讓純前端改動被擋
  const contextOnly = `${header}   // 改動走樂觀更新、失敗回滾。\n-  const a = 1;\n+  const a = 2;\n`;
  assert.equal(classifySelfChange(changed, contextOnly).critical, false);
  assert.equal(classifySelfChange(changed, `${header}-  // 失敗回滾\n+  // gone\n`).critical, true);
  assert.equal(classifySelfChange(changed, `${header}   ctx\n+  skipRollback(); // rollback disabled\n`).critical, true);
  // 檔名標頭含關鍵字（例如 rollback.ts）不算內容改動，但改到真的程式行照攔
  const fileHeader = "diff --git a/x/rollback.ts b/x/rollback.ts\n--- a/x/rollback.ts\n+++ b/x/rollback.ts\n@@ -1 +1 @@\n-const n = 1;\n+const n = 2;\n";
  assert.equal(classifySelfChange(["x/rollback.ts"], fileHeader).critical, false);
});

test("index.ts 裡改到自裝觸發／開機晉升的接線 → critical", () => {
  assert.equal(classifySelfChange(["server/src/index.ts"], "-  void resolvePendingSelfInstallOnBoot();").critical, true);
  assert.equal(classifySelfChange(["server/src/index.ts"], '+app.post("/api/self-install/auto", () => {})').critical, true);
  assert.equal(classifySelfChange(["server/src/index.ts"], "+  const head = readRepoHead(SELF_REPO);").critical, true);
});

test("偷放寬唯讀查詢邊界／核准分類 → critical", () => {
  assert.equal(classifySelfChange(["server/src/index.ts"], "+ queryToolPolicy now returns allowed=true always").critical, true);
  assert.equal(classifySelfChange(["server/src/x.ts"], "+ evaluateAutoApproval -> allow all").critical, true);
});

test("describeSelfChangeBlock：critical 給一行理由、非 critical 空字串", () => {
  const crit = classifySelfChange(["server/src/toolPolicy.ts"]);
  assert.match(describeSelfChangeBlock(crit), /需 owner 拍板/);
  const safe = classifySelfChange(["server/src/foo.ts"]);
  assert.equal(describeSelfChangeBlock(safe), "");
});

test("空輸入安全（不崩、非 critical）", () => {
  assert.equal(classifySelfChange([]).critical, false);
  assert.equal(classifySelfChange(["", "   "]).critical, false);
});

const section = (file: string, body: string, extraHeader = "") =>
  `diff --git a/${file} b/${file}\n${extraHeader}--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}`;

test("內容行剛好長得像「+++ 」「--- 」標頭也照掃（++i／--i 開頭的程式行不能藏剎車改動）", () => {
  assert.equal(classifySelfChange(["server/src/x.ts"], section("server/src/x.ts", "+++ i; evaluateAutoApproval = () => true;\n")).critical, true);
  assert.equal(classifySelfChange(["server/src/x.ts"], section("server/src/x.ts", "--- n; // 回滾 guard removed\n")).critical, true);
});

test("改 build/test/package 指令（全綠才出貨的那道關）→ critical；只升級套件不擋", () => {
  const scripts = section("server/package.json", '-    "test": "tsx --test test/**/*.test.ts",\n+    "test": "exit 0",\n');
  assert.equal(classifySelfChange(["server/package.json"], scripts).critical, true);
  const bump = section("server/package.json", '-    "express": "^4.21.0",\n+    "express": "^4.21.2",\n');
  assert.equal(classifySelfChange(["server/package.json"], bump).critical, false);
});

test("拿掉只准綁 loopback 的檢查 → critical", () => {
  assert.equal(classifySelfChange(["server/src/config.ts"], section("server/src/config.ts", "-if (!isLoopbackHost(configuredHost)) {\n")).critical, true);
});

test("比對不到內容的改動 → critical：UTF-16 程式檔、symlink、submodule；圖片等二進位資產不擋", () => {
  const utf16 = section("server/src/x.ts", `+${Buffer.from("SelfInstall()", "utf16le").toString("latin1")}\n`);
  assert.deepEqual(findUnscannableDiffFiles(utf16), ["server/src/x.ts"]);
  assert.equal(classifySelfChange(["server/src/x.ts"], utf16).critical, true);

  const png = section("assets/icons/a.png", "+\u0089PNG\u0000\u0000\u0000\rIHDR\n");
  assert.deepEqual(findUnscannableDiffFiles(png), []);
  assert.equal(classifySelfChange(["assets/icons/a.png"], png).critical, false);

  const link = "diff --git a/server/src/shim.ts b/server/src/shim.ts\nnew file mode 120000\nindex 0000000..1234567\n--- /dev/null\n+++ b/server/src/shim.ts\n@@ -0,0 +1 @@\n+/tmp/outside.ts\n\\ No newline at end of file\n";
  assert.deepEqual(findUnscannableDiffFiles(link), ["server/src/shim.ts"]);
  const retarget = "diff --git a/server/src/shim.ts b/server/src/shim.ts\nindex 1234567..89abcde 120000\n--- a/server/src/shim.ts\n+++ b/server/src/shim.ts\n@@ -1 +1 @@\n-a.ts\n+/tmp/b.ts\n";
  assert.deepEqual(findUnscannableDiffFiles(retarget), ["server/src/shim.ts"]);
  const submodule = "diff --git a/vendor/x b/vendor/x\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/vendor/x\n@@ -0,0 +1 @@\n+Subproject commit 1234567\n";
  assert.equal(classifySelfChange(["vendor/x"], submodule).critical, true);

  // 一般文字檔、一般權限變更不受影響
  assert.deepEqual(findUnscannableDiffFiles(section("server/src/y.ts", "-a\n+b\n", "old mode 100644\nnew mode 100755\n")), []);
});
