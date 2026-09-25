// 列出 server/web 所有「t()/tc() 有用到、但英文字典缺譯」的 key，輸出成 JSON 供補翻。
// 邏輯對齊 server/i18n-check.cjs 與 web/i18n-check.cjs 的掃描方式。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collect(srcRoot, dictDir) {
  const dicts = {};
  for (const f of fs.readdirSync(dictDir)) {
    const src = fs.readFileSync(path.join(dictDir, f), "utf8");
    const re = /"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(src))) dicts[JSON.parse('"' + m[1] + '"')] = 1;
  }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "i18n" && e.name !== "node_modules") walk(p); }
      else if (/\.tsx?$/.test(e.name) && e.name !== "i18n.ts" && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  })(srcRoot);
  const missing = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    let m;
    const re = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
    while ((m = re.exec(src))) { const k = JSON.parse('"' + m[1] + '"'); if (!(k in dicts)) missing.add(k); }
    const reTc = /\btc\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
    while ((m = reTc.exec(src))) { const k = JSON.parse('"' + m[2] + '"'); if (!(k in dicts)) missing.add(k); }
  }
  return [...missing];
}

const server = collect(path.join(root, "server/src"), path.join(root, "server/src/i18n"));
const web = collect(path.join(root, "web/src"), path.join(root, "web/src/i18n"));
const out = path.join(root, ".debug-data", "missing-i18n.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ server, web }, null, 1));
console.log("server missing:", server.length, "| web missing:", web.length, "| ->", out);
