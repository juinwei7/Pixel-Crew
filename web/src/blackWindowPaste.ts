// xterm.js only ever pastes `text/plain`, so an image on the clipboard is
// dropped before it can reach the PTY. These helpers pick the images out of a
// paste event so the pane can stage them on the server and type the resulting
// paths into the CLI instead.

export const PASTE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Matches MAX_MESSAGE_IMAGES on the server; the rest of a paste is ignored. */
export const MAX_PASTE_IMAGES = 4;

/** Structural so tests can pass a plain object instead of a real DataTransfer. */
type ClipboardFile = { type: string; name?: string };

export function clipboardImages<T extends ClipboardFile>(clipboard: { files?: ArrayLike<T> | null } | null | undefined): T[] {
  const files = clipboard?.files;
  if (!files) return [];
  return Array.from({ length: files.length }, (_, index) => files[index])
    .filter((file): file is T => Boolean(file) && (PASTE_IMAGE_MIME_TYPES as readonly string[]).includes(file.type))
    .slice(0, MAX_PASTE_IMAGES);
}

/**
 * A CLI composer only recognises one image path per chunk, so staged paths are
 * typed one at a time. The gap keeps them in separate PTY reads.
 */
export const PASTE_INJECT_GAP_MS = 120;
