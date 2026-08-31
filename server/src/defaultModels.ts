import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "./providers/types.js";

export type ProviderDefaultModels = Record<ProviderId, string>;

// A local provider setting wins. These are only fallbacks for a fresh CLI that
// has not created its settings file yet.
export const FALLBACK_DEFAULT_MODELS: ProviderDefaultModels = {
  claude: "sonnet",
  codex: "gpt-5.6-terra",
};

type ReadText = (path: string) => string;

function configuredValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*[=:]\\s*["']([^"']+)["']`, "m"));
  return match?.[1]?.trim() || null;
}

// We read only the model scalar and expose only that value; no other local
// configuration is parsed, stored, or sent to the browser.
export function configuredDefaultModels(
  home = homedir(),
  readText: ReadText = (path) => readFileSync(path, "utf8"),
): ProviderDefaultModels {
  const defaults = { ...FALLBACK_DEFAULT_MODELS };
  try {
    defaults.codex = configuredValue(readText(join(home, ".codex", "config.toml")), "model") ?? defaults.codex;
  } catch { /* no Codex config yet */ }
  try {
    const settings = JSON.parse(readText(join(home, ".claude", "settings.json"))) as { model?: unknown };
    if (typeof settings.model === "string" && settings.model.trim()) defaults.claude = settings.model.trim();
  } catch { /* no Claude settings yet or an in-progress settings edit */ }
  return defaults;
}
