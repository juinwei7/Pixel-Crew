import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const assetsDir = join(import.meta.dirname, "..", "web", "dist", "assets");
const files = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
if (!files.length) throw new Error("No web build assets found. Run `npm run build -w web` first.");

const budgets = [
  // 1ad9b3b 起 entry 只剩開機殼層（ErrorBoundary、ensureLanguage、動態 import App），
  // 現況 ~12 KiB。上限壓在 64 KiB：任何東西被同步拉回 entry 都會立刻被擋下。
  { name: "application entry", match: /^index-[\w-]+\.js$/, max: 64 * 1024 },
  // 原本住在 entry 的 app 程式碼（v2.5.2 時 ~376 KiB）整塊搬進 App chunk，開機後
  // 第一時間就載。現況 ~296 KiB + 餘裕 = 320 KiB，繼續擋住 vendor 意外洩進來。
  { name: "application shell", match: /^App-[\w-]+\.js$/, max: 320 * 1024 },
  { name: "Pixi vendor", match: /^pixi-[\w-]+\.js$/, max: 620 * 1024 },
  { name: "rich text vendor", match: /^rich-text-[\w-]+\.js$/, max: 380 * 1024 },
  // i18n 模組本體（語言偵測 + 查表）很小，跟在 entry 旁邊載入。
  { name: "i18n runtime", match: /^i18n-(?!en-)[\w-]+\.js$/, max: 16 * 1024 },
  // 英文字典在 lang 決定為英文後才動態載入，中文使用者不會下載。1ad9b3b 補譯
  // 後現況 ~144 KiB + 餘裕 = 160 KiB。
  { name: "English catalog", match: /^i18n-en-[\w-]+\.js$/, max: 160 * 1024 },
  // three.js is only pulled in by QrTree's remote-access QR animation; it's
  // isolated into its own vendor chunk (see vite.config.ts manualChunks) so
  // RemoteAccessModal's own feature code stays under the generic lazy cap
  // below instead of smuggling ~420 KiB of vendor library through it.
  { name: "three.js vendor", match: /^three-vendor-[\w-]+\.js$/, max: 460 * 1024 },
  { name: "xterm vendor", match: /^xterm-vendor-[\w-]+\.js$/, max: 400 * 1024 },
  // 像素辦公室場景（web/src/game：Pixi 精靈、動畫特效、桌位版面、NPC 行為）由
  // GameCanvas 動態載入，不進 entry。它是一整塊功能而非單一面板，體積遠大於一般
  // lazy modal，所以給它自己的上限。fce23d2 動畫互動大改版、1ad9b3b 作戰室場景後
  // 現況 ~180 KiB + 餘裕 = 200 KiB，而不是套用下方 80 KiB 的通用 lazy 上限。Pixi
  // 本體仍在自己的 vendor chunk。UI 需要的少量場景資料（crewLook / furnitureDefs /
  // nameplateLod 等）刻意保持輕量、留在 App chunk。
  { name: "office scene", match: /^scene-[\w-]+\.js$/, max: 200 * 1024 },
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
