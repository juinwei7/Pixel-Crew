import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bashRedirectsOutsideWorkspace } from "../src/bashWriteFence.js";

const WS = process.platform === "win32" ? "C:\\work\\ws" : "/work/ws";
const OUTSIDE_ABS = process.platform === "win32" ? "C:\\work\\secret.txt" : "/etc/passwd";

test("flags write redirections whose target escapes the workspace", () => {
  assert.equal(bashRedirectsOutsideWorkspace(WS, `echo secret > ${OUTSIDE_ABS}`), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x >> ../escape.txt"), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "cat report.md > ../../leak.txt"), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, `printf hi >"${OUTSIDE_ABS}"`), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, `echo a > ${join(WS, "..", "sib", "x.txt")}`), true);
});

test("allows redirections that stay inside the workspace, and non-writing commands", () => {
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo done > outbox/report.md"), false);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x > report.md"), false);
  assert.equal(bashRedirectsOutsideWorkspace(WS, `echo x > ${join(WS, "outbox", "final.pdf")}`), false); // 絕對路徑指回 workspace 內
  assert.equal(bashRedirectsOutsideWorkspace(WS, "cat notes.md"), false); // 純讀取，無寫入
  assert.equal(bashRedirectsOutsideWorkspace(WS, "grep foo /etc/hosts"), false); // 讀外部但無重導向寫入
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo hi"), false);
});

test("does not misfire on fd redirections and discard-style targets", () => {
  assert.equal(bashRedirectsOutsideWorkspace(WS, "npm test 2>/dev/null"), false);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "npm run build 2>&1"), false);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x > /dev/null"), false);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "npm test > build.log 2>&1"), false); // build.log 在 workspace 內
});

// 誠實邊界：以下繞過本函式**認不出**（防禦縱深非圍牆，見 §九）。
// 鎖定為「已知不涵蓋」，避免日後有人誤以為 Bash 外傳已被完全堵死。
test("documented residual bypasses are NOT flagged (defense-in-depth, not a wall)", () => {
  const p = process.platform === "win32" ? "C:\\work\\secret.txt" : "/etc/passwd";
  assert.equal(bashRedirectsOutsideWorkspace(WS, `dst=${p}; echo x > "$dst"`), false); // 變數展開
  assert.equal(bashRedirectsOutsideWorkspace(WS, `cp report.md ${p}`), false);           // cp 目的地
  assert.equal(bashRedirectsOutsideWorkspace(WS, `echo x | tee ${p}`), false);           // tee
  assert.equal(bashRedirectsOutsideWorkspace(WS, `python -c "open('${p}','w').write('x')"`), false); // 直譯器
});
