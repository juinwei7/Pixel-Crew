import assert from "node:assert/strict";
import { homedir } from "node:os";
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

test("flags fd-numbered, &>, >&file and clobber redirections that escape the workspace", () => {
  for (const command of [
    `echo secret 1> ${OUTSIDE_ABS}`,
    `node leak.js 2> ${OUTSIDE_ABS}`,
    "npm test 2>> ../escape.log",
    `cat .env &> ${OUTSIDE_ABS}`,
    "cat .env &>> ../escape.txt",
    `cat .env >& ${OUTSIDE_ABS}`,
    `cat .env >&${OUTSIDE_ABS}`,
    `echo x >| ${OUTSIDE_ABS}`,
    `echo x >! ${OUTSIDE_ABS}`, // zsh 的強制覆寫
    "echo x 3> ../escape.txt",
  ]) {
    assert.equal(bashRedirectsOutsideWorkspace(WS, command), true, command);
  }
});

test("expands ~ and $HOME the way the shell does before checking the target", () => {
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x > ~/.ssh/authorized_keys"), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x >> ~"), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x > $HOME/.zshrc"), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, 'echo x > "${HOME}/.bashrc"'), true);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x > ~root/x"), true); // ~user 無法判定 → 當逃逸
  // 引號內的 ~ 不展開、單引號內的 $HOME 也不展開：都是 workspace 內的字面相對路徑。
  assert.equal(bashRedirectsOutsideWorkspace(WS, 'echo x > "~/notes.md"'), false);
  assert.equal(bashRedirectsOutsideWorkspace(WS, "echo x > '$HOME/notes.md'"), false);
  // workspace 本身就在家目錄下時，~ 指回 workspace 內的寫入照常放行。
  const homeWs = join(homedir(), "pixel-crew-ws");
  assert.equal(bashRedirectsOutsideWorkspace(homeWs, "echo x > ~/pixel-crew-ws/outbox/a.md"), false);
});

test("fd duplication/closing and in-workspace fd redirections are not flagged", () => {
  for (const command of [
    "npm test 2>&1",
    "echo err >&2",
    "echo err 1>&2",
    "exec 3>&-",
    "npm test >& 2",
    "npm test &>/dev/null",
    "npm test > /dev/null 2>&1",
    "npm test 2> build.log",
    "npm test &> build.log",
    "echo x >| report.md",
  ]) {
    assert.equal(bashRedirectsOutsideWorkspace(WS, command), false, command);
  }
});
