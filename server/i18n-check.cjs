// server 版 i18n 一致性檢查（對照 web/i18n-check.cjs）：
// 1) src/i18n/ 各字典檔跨檔重複 key（同 key 不同譯文才算衝突）
// 2) src/ 下所有 t("...")/tc("ctx","...") 字面呼叫是否都有字典條目（tc 可退回無語境 key）
// node server/i18n-check.cjs
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "src");
const dictDir = path.join(root, "i18n");
const dicts = {}; const owner = {}; const dupes = [];
for (const f of fs.readdirSync(dictDir)) {
  const src = fs.readFileSync(path.join(dictDir, f), "utf8");
  const re = /"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/g; let m;
  while ((m = re.exec(src))) {
    const key = JSON.parse('"' + m[1] + '"');
    const val = m[2];
    if (owner[key] && owner[key] !== f && dicts[key] !== val) dupes.push(key + "  [" + dicts[key] + " | " + val + "]  (" + owner[key] + " vs " + f + ")");
    owner[key] = f; dicts[key] = val;
  }
}
console.log("dict total keys:", Object.keys(dicts).length);
console.log("cross-file duplicate keys:", dupes.length);
for (const d of dupes) console.log("  DUP:", d);
const missing = new Set(); const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "i18n") walk(p); }
    else if (/\.ts$/.test(e.name) && e.name !== "i18n.ts" && !/\.test\.ts$/.test(e.name)) files.push(p);
  }
})(root);
let calls = 0, tcCalls = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const re = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g; let m;
  while ((m = re.exec(src))) {
    calls++;
    const key = JSON.parse('"' + m[1] + '"');
    if (!(key in dicts)) missing.add(path.relative(root, f) + " :: " + key);
  }
  const reTc = /\btc\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  while ((m = reTc.exec(src))) {
    tcCalls++;
    const ctx = JSON.parse('"' + m[1] + '"'), text = JSON.parse('"' + m[2] + '"');
    if (!((ctx + "::" + text) in dicts) && !(text in dicts)) missing.add(path.relative(root, f) + " :: " + ctx + "::" + text);
  }
}
console.log("t() string-literal calls:", calls, "/ tc():", tcCalls);
console.log("keys missing from dicts:", missing.size);
for (const k of [...missing].slice(0, 30)) console.log("  MISS:", k);
