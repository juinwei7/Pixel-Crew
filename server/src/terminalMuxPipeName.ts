import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { win32 } from "node:path";

// Hashing the full canonical path (not truncating its raw bytes) matters on
// Windows: two sibling data directories that only differ near the end (e.g.
// "Pixel Crew" vs "Pixel Crew Dev") would otherwise share the first ~16
// bytes of their hex encoding and collide onto the same named pipe.
export function terminalMuxPipeName(dataDirectory: string): string {
  let canonical = win32.resolve(dataDirectory);
  // Collapse junctions/symlinks when the directory already exists. During
  // early startup it may not, so retain the stable lexical resolution.
  if (process.platform === "win32") {
    try { canonical = realpathSync.native(canonical); } catch { /* use lexical path */ }
  }
  canonical = canonical.toLocaleLowerCase("en-US");
  return `\\\\.\\pipe\\pixel-crew-mux-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
