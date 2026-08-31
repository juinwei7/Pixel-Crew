// Shared by codexAccountLogin.ts and claudeAccountLogin.ts: both spawn a CLI
// that prints a fallback "open this URL if your browser didn't" line for the
// owner to click when headless auto-open doesn't work.

// OSC 8 terminal hyperlink: ESC ] 8 ; ; URL BEL label ESC ] 8 ; ; BEL — Claude
// Code wraps its fallback URL this way, with label and target being the same
// text. A naive \S+ match would swallow the BEL-separated label into the
// "URL" (no whitespace separates them), so this shape must be tried first.
function extractOsc8Url(text: string): string | null {
  const match = text.match(/\x1b\]8;;(https?:\/\/[^\x07]+)\x07/);
  return match ? match[1] : null;
}

// Codex just prints plain text, and its output has TWO URLs up front:
// "Starting local login server on http://localhost:1455." (the callback
// receiver, not useful to click) THEN the real one. Prefer the non-localhost
// one; trims trailing punctuation a sentence wrapping the URL might leave attached.
function extractPlainUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/\S+/g);
  if (!matches) return null;
  const candidate = matches.find((url) => !/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url)) ?? matches[matches.length - 1];
  return candidate.replace(/[).,;]+$/, "");
}

export function extractLoginUrl(text: string): string | null {
  return extractOsc8Url(text) ?? extractPlainUrl(text);
}
