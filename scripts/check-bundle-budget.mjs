import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const assetsDir = join(import.meta.dirname, "..", "web", "dist", "assets");
const files = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
if (!files.length) throw new Error("No web build assets found. Run `npm run build -w web` first.");

const budgets = [
  // 上限在 v2.5.0 定為 360 KiB；v2.5.1 的 i18n 補完、v2.5.2 的功能程式，以及
  // 包住整個 App、必須同步載入的 ErrorBoundary（lazy chunk 讀取失敗時自動復原、
  // 避免整頁黑屏）讓 entry（純 app code，vendor 都已拆進各自 chunk）自然長到
  // ~376 KiB。這個 guard 的目的是擋住「vendor 意外洩進 entry」這類暴衝，不是
  // 阻止正常功能成長，因此調高到 384 KiB（現況 + 一點餘裕），繼續擋住意外膨脹。
  { name: "application entry", match: /^index-[\w-]+\.js$/, max: 384 * 1024 },
  { name: "Pixi vendor", match: /^pixi-[\w-]+\.js$/, max: 620 * 1024 },
  { name: "rich text vendor", match: /^rich-text-[\w-]+\.js$/, max: 380 * 1024 },
  // 英文字典補完（2026-09，從 ~100 KiB 到 ~114 KiB；v2.5.1 再補譯 203 句到
  // ~121 KiB）之後調高。這個 chunk 是靜態 import，所以中文使用者也會下載到——
  // 真正的解法是等 lang 決定後才動態載入字典，但那會讓 i18n 模組變成 async，
  // 牽動所有 importer 的初始化順序，不適合在發版前動。先把上限訂在
  // 「補完後 + 一點餘裕」，繼續擋住意外膨脹。
  { name: "i18n catalog", match: /^i18n-[\w-]+\.js$/, max: 128 * 1024 },
  // three.js is only pulled in by QrTree's remote-access QR animation; it's
  // isolated into its own vendor chunk (see vite.config.ts manualChunks) so
  // RemoteAccessModal's own feature code stays under the generic lazy cap
  // below instead of smuggling ~420 KiB of vendor library through it.
  { name: "three.js vendor", match: /^three-vendor-[\w-]+\.js$/, max: 460 * 1024 },
  { name: "xterm vendor", match: /^xterm-vendor-[\w-]+\.js$/, max: 400 * 1024 },
];

const errors = [];
const known = new Set();
for (const budget of budgets) {
  const match = files.find((file) => budget.match.test(file));
  if (!match) { errors.push(`${budget.name}: expected chunk is missing`); continue; }
  known.add(match);
  const bytes = statSync(join(assetsDir, match)).size;
  if (bytes > budget.max) errors.push(`${budget.name}: ${(bytes / 1024).toFixed(1)} KiB exceeds ${(budget.max / 1024).toFixed(0)} KiB (${match})`);
}

for (const file of files.filter((file) => !known.has(file) && !/^rolldown-runtime-/.test(file) && !/^react-/.test(file) && !/^yaml-/.test(file))) {
  const bytes = statSync(join(assetsDir, file)).size;
  if (bytes > 80 * 1024) errors.push(`lazy feature: ${(bytes / 1024).toFixed(1)} KiB exceeds 80 KiB (${file})`);
}

if (errors.length) throw new Error(`Bundle budget failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
console.log(`Bundle budget passed (${files.length} JS chunks checked).`);
