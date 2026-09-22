// Regenerates every shipped icon from scripts/icons/icon-art.mjs.
//
//   npm run icons
//
// The results are committed, because the Windows packager needs the .ico
// before `dotnet publish` runs and the marketing site serves the PNG/SVG
// directly. server/test/appIcons.test.ts fails if they drift from the art.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ICNS_SIZES, ICO_SIZES, buildIcns, buildIco, encodePng } from "./icon-files.mjs";
import { renderIcon, renderIconSvg } from "./icon-render.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function iconOutputs() {
  const rendered = new Map();
  const render = (size) => {
    if (!rendered.has(size)) rendered.set(size, renderIcon(size));
    return rendered.get(size);
  };
  const svg = renderIconSvg();
  return [
    { path: "assets/icons/pixel-crew.icns", data: buildIcns(new Map(ICNS_SIZES.map((size) => [size, render(size)]))) },
    { path: "assets/icons/pixel-crew.ico", data: buildIco(ICO_SIZES.map(render)) },
    { path: "assets/icons/pixel-crew-1024.png", data: encodePng(render(1024)) },
    { path: "PixelCrew/apple-touch-icon.png", data: encodePng(render(512)) },
    { path: "PixelCrew/favicon.svg", data: Buffer.from(svg, "utf8") },
    { path: "web/public/favicon.svg", data: Buffer.from(svg, "utf8") },
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const output of iconOutputs()) {
    const path = join(root, output.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output.data);
    console.log(`${relative(root, path)} (${output.data.length.toLocaleString("en-US")} bytes)`);
  }
}
