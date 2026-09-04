import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = join(root, "PixelCrew");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const releaseDate = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m").exec(changelog)?.[1];
if (!releaseDate) throw new Error(`CHANGELOG.md has no dated v${version} release`);
// The site transparently documents source-available work after the latest
// formal release, so its editorial date is intentionally newer than v2.0.1.
const expectedLastModified = "2026-09-04";
const errors = [];

const fail = (scope, message) => errors.push(`${scope}: ${message}`);
const read = (path) => readFileSync(path, "utf8");
const attr = (tag, name) => new RegExp(`\\s${name}=["']([^"']+)["']`, "i").exec(tag)?.[1] ?? null;
const matches = (html, expression) => [...html.matchAll(expression)];

const pages = [
  {
    file: join(siteRoot, "index.html"),
    scope: "zh-Hant",
    lang: "zh-Hant",
    canonical: "https://pixelcrew.weibuilds.com/",
    title: "Pixel Crew — 把 Claude Code 與 Codex 變成一間像素辦公室",
  },
  {
    file: join(siteRoot, "en", "index.html"),
    scope: "en",
    lang: "en",
    canonical: "https://pixelcrew.weibuilds.com/en/",
    title: "Pixel Crew — Claude Code and Codex in One Pixel Office",
  },
];

const descriptions = new Set();

for (const page of pages) {
  const html = read(page.file);
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  const title = /<title>([^<]+)<\/title>/i.exec(html)?.[1]?.trim();
  const descriptionTag = /<meta\b[^>]*name=["']description["'][^>]*>/i.exec(html)?.[0] ?? "";
  const description = attr(descriptionTag, "content");
  const canonicalTag = /<link\b[^>]*rel=["']canonical["'][^>]*>/i.exec(html)?.[0] ?? "";
  const canonical = attr(canonicalTag, "href");
  const h1Count = matches(html, /<h1\b/gi).length;

  if (attr(htmlTag, "lang") !== page.lang) fail(page.scope, `expected html lang ${page.lang}`);
  if (title !== page.title) fail(page.scope, "title is missing or unexpected");
  if (!description || description.length < 100 || description.length > 180) fail(page.scope, "meta description should be 100–180 characters");
  if (description && descriptions.has(description)) fail(page.scope, "meta description must be unique");
  if (description) descriptions.add(description);
  if (canonical !== page.canonical) fail(page.scope, `canonical must be ${page.canonical}`);
  if (h1Count !== 1) fail(page.scope, `expected exactly one h1, found ${h1Count}`);
  if (/<meta\b[^>]*name=["']keywords["']/i.test(html)) fail(page.scope, "do not add ignored meta keywords");

  const alternates = new Map(matches(html, /<link\b[^>]*rel=["']alternate["'][^>]*hreflang=["'][^"']+["'][^>]*>/gi)
    .map(([tag]) => [attr(tag, "hreflang"), attr(tag, "href")]));
  for (const [language, url] of [["zh-Hant", pages[0].canonical], ["en", pages[1].canonical], ["x-default", pages[0].canonical]]) {
    if (alternates.get(language) !== url) fail(page.scope, `missing reciprocal hreflang ${language}`);
  }

  const jsonLdBlocks = matches(html, /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdBlocks.length !== 1) fail(page.scope, "expected exactly one JSON-LD graph");
  for (const [, source] of jsonLdBlocks) {
    try {
      const graph = JSON.parse(source)["@graph"];
      const software = graph?.find((entry) => entry["@type"] === "SoftwareApplication");
      const webPage = graph?.find((entry) => entry["@type"] === "WebPage");
      const organization = graph?.find((entry) => entry["@type"] === "Organization");
      if (software?.softwareVersion !== version) fail(page.scope, `schema softwareVersion must match ${version}`);
      if (software?.releaseNotes !== `https://github.com/juinwei7/Pixel-Crew/releases/tag/v${version}`) fail(page.scope, "schema releaseNotes is stale");
      if (webPage?.dateModified !== expectedLastModified) fail(page.scope, "schema dateModified is stale");
      if (webPage?.inLanguage !== page.lang) fail(page.scope, "schema WebPage language is incorrect");
      if (!organization?.logo?.url) fail(page.scope, "Organization logo is missing");
    } catch (error) {
      fail(page.scope, `invalid JSON-LD: ${error.message}`);
    }
  }

  if (!html.includes(`v${version}`)) fail(page.scope, `visible release version v${version} is missing`);

  const ids = matches(html, /\sid=["']([^"']+)["']/gi).map(([, id]) => id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) fail(page.scope, `duplicate ids: ${[...new Set(duplicateIds)].join(", ")}`);
  for (const [, anchor] of matches(html, /href=["']#([^"']+)["']/gi)) {
    if (!ids.includes(anchor)) fail(page.scope, `anchor #${anchor} has no target`);
  }

  for (const [tag] of matches(html, /<img\b[^>]*>/gi)) {
    if (!attr(tag, "alt")?.trim()) fail(page.scope, `image ${attr(tag, "src") ?? "unknown"} has no alt text`);
    if (!attr(tag, "width") || !attr(tag, "height")) fail(page.scope, `image ${attr(tag, "src") ?? "unknown"} needs width and height`);
  }

  for (const [, name, url] of matches(html, /\s(src|srcset|href)=["']([^"'#?]+)["']/gi)) {
    if (/^(https?:|mailto:|data:)/i.test(url) || url === "/" || url === "/en/") continue;
    const localPath = url.startsWith("/") ? join(siteRoot, url.slice(1)) : resolve(dirname(page.file), url);
    if (!existsSync(localPath)) fail(page.scope, `${name} points to missing local file ${url}`);
  }
}

const sitemap = read(join(siteRoot, "sitemap.xml"));
for (const page of pages) {
  if (!sitemap.includes(`<loc>${page.canonical}</loc>`)) fail("sitemap", `missing ${page.canonical}`);
}
if (!sitemap.includes(`<lastmod>${expectedLastModified}</lastmod>`)) fail("sitemap", "accurate lastmod is missing");
if (/<(?:changefreq|priority)>/.test(sitemap)) fail("sitemap", "remove fields ignored by Google");
for (const language of ["zh-Hant", "en", "x-default"]) {
  if (!sitemap.includes(`hreflang="${language}"`)) fail("sitemap", `missing hreflang ${language}`);
}

const robots = read(join(siteRoot, "robots.txt"));
if (!robots.includes("Sitemap: https://pixelcrew.weibuilds.com/sitemap.xml")) fail("robots", "sitemap declaration is missing");
try { JSON.parse(read(join(siteRoot, "site.webmanifest"))); } catch (error) { fail("manifest", error.message); }
if (!existsSync(join(siteRoot, "favicon.svg"))) fail("favicon", "favicon.svg is missing");

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`SEO validation passed for ${pages.length} localized pages at v${version}.`);
}
