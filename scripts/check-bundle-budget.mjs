import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const assetsDir = join(import.meta.dirname, "..", "web", "dist", "assets");
const files = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
if (!files.length) throw new Error("No web build assets found. Run `npm run build -w web` first.");

const budgets = [
  { name: "application entry", match: /^index-[\w-]+\.js$/, max: 360 * 1024 },
  { name: "Pixi vendor", match: /^pixi-[\w-]+\.js$/, max: 620 * 1024 },
  { name: "rich text vendor", match: /^rich-text-[\w-]+\.js$/, max: 380 * 1024 },
  { name: "i18n catalog", match: /^i18n-[\w-]+\.js$/, max: 110 * 1024 },
  // three.js is only pulled in by QrTree's remote-access QR animation; it's
  // isolated into its own vendor chunk (see vite.config.ts manualChunks) so
  // RemoteAccessModal's own feature code stays under the generic lazy cap
  // below instead of smuggling ~420 KiB of vendor library through it.
  { name: "three.js vendor", match: /^three-vendor-[\w-]+\.js$/, max: 460 * 1024 },
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
