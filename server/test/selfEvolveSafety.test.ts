// 自我進化安全網不變量（階段 2）測試：證明「動到剎車＝critical＝回 owner」，
// 「只動非安全部分＝可自裝」，且不變量保守（寧可多攔）。這是讓自部署不變自毀的命根。
import assert from "node:assert/strict";
import test from "node:test";
import { classifySelfChange, describeSelfChangeBlock } from "../src/selfEvolveSafety.js";

test("動到保護機制檔案 → critical（不看內容）", () => {
  for (const f of [
    "server/src/toolPolicy.ts",
    "server/src/dangerousCommand.ts",
    "server/src/bashWriteFence.ts",
    "server/src/selfEvolveSafety.ts",
    "coldinstall/pixel-crew/app.exe",
    "scripts/windows/pc-coldinstall.ps1",
    "scripts/windows/package-app.mjs",
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
