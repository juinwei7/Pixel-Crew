import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectorySync, protectFileSync } from "./platform/fileProtection.js";
import type { MessageImage } from "./providers/session.js";
import { config } from "./config.js";

// Black Window is a raw PTY: an image on the clipboard never reaches the CLI
// through the browser, because xterm.js only pastes `text/plain`. Both the
// Claude and Codex composers do turn a typed image path into an attachment,
// so a pasted image is staged as a file here and its path typed into the
// terminal instead.
//
// Every behaviour below was verified against the real CLIs (claude 2.1.236,
// codex 0.154.0), because none of it is documented:
//   - a plain typed path is enough; bracketed-paste markers are not needed
//   - a path containing a space is NOT recognised unless it is quoted
//   - two paths in one chunk are NOT recognised; they must arrive separately

/** Long enough for any turn the paste belongs to, short enough to stay tidy. */
export const TERMINAL_PASTE_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_TERMINAL_PASTE_FILES = 40;

const SHELL_SAFE = /^[A-Za-z0-9_./\\:+,@%=-]+$/;

export function terminalPastesDirectory(): string {
  return join(config.dataDirectory, "terminal-pastes");
}

/**
 * The typed form of a staged path. A Black Window pane may equally be sitting
 * at a shell prompt rather than in a CLI composer, so the token has to be safe
 * to read as a single shell word too.
 */
export function terminalPathToken(path: string, platform: NodeJS.Platform = process.platform): string {
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error("Staged image path contains control characters");
  if (SHELL_SAFE.test(path)) return path;
  // Windows paths are built from backslashes, so escaping them would corrupt
  // the path; a quote cannot appear in a Windows filename in the first place.
  if (platform === "win32") return `"${path.replace(/"/g, "")}"`;
  return `"${path.replace(/(["$`\\])/g, "\\$1")}"`;
}

export function stageTerminalPasteImages(images: MessageImage[], directory = terminalPastesDirectory()): string[] {
  if (images.length === 0) return [];
  ensurePrivateDirectorySync(directory);
  pruneTerminalPastes(directory);
  const staged: string[] = [];
  try {
    for (const image of images) {
      const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : "webp";
      const path = join(directory, `paste-${randomUUID()}.${extension}`);
      writeFileSync(path, Buffer.from(image.dataBase64, "base64"), { mode: 0o600 });
      protectFileSync(path);
      staged.push(path);
    }
    return staged;
  } catch (error) {
    for (const path of staged) rmSync(path, { force: true });
    throw error;
  }
}

/**
 * Nothing reports when a CLI has finished reading a staged file, so the
 * directory is swept by age and count on the next paste rather than tracked
 * per turn the way task attachments are.
 */
export function pruneTerminalPastes(directory: string, now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  const files = names
    .filter((name) => name.startsWith("paste-"))
    .map((name) => {
      const path = join(directory, name);
      try { return { path, modified: statSync(path).mtimeMs }; } catch { return null; }
    })
    .filter((entry): entry is { path: string; modified: number } => entry !== null)
    .sort((left, right) => right.modified - left.modified);
  files.forEach((file, index) => {
    if (index < MAX_TERMINAL_PASTE_FILES && now - file.modified < TERMINAL_PASTE_TTL_MS) return;
    rmSync(file.path, { force: true });
  });
}
