import { t } from "./i18n";

export type PaletteEntry = { name: string; description: string; argumentHint?: string };
export type ProviderWorkflowEntry = PaletteEntry & {
  key: string;
  label: string;
  value: string;
  invocation: "/" | "$";
};

/**
 * Merge the fetched project commands (`library`, with descriptions) with the
 * provider's full slash-command set (`slashCommands`, names only: built-ins +
 * skills + project). Project commands come first for their richer metadata;
 * the rest follow, de-duplicated by name. This keeps built-in commands like
 * /clear visible in rooms that also have their own project commands.
 */
export function mergePaletteNames(library: PaletteEntry[], slashCommands: string[]): PaletteEntry[] {
  const seen = new Set(library.map((entry) => entry.name));
  const extra = slashCommands
    .filter((name) => !seen.has(name))
    .map((name) => ({ name, description: t("Claude 指令") }));
  return [...library, ...extra];
}

/**
 * Build provider-aware workflow entries. Claude project commands and native
 * commands both use `/`; Codex deliberately keeps repo skills on `$` while
 * its native controls use `/`, matching the official Codex composer.
 */
export function buildProviderWorkflowEntries(
  provider: "claude" | "codex",
  library: PaletteEntry[],
  slashCommands: string[],
): ProviderWorkflowEntry[] {
  if (provider === "claude") {
    return mergePaletteNames(library, slashCommands).map((entry) => ({
      ...entry,
      key: `slash-${entry.name}`,
      label: `/${entry.name}`,
      value: `/${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : " "}`,
      invocation: "/" as const,
    }));
  }

  const skills = library.map((entry) => ({
    ...entry,
    key: `skill-${entry.name}`,
    label: `$${entry.name}`,
    value: `$${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : " "}`,
    invocation: "$" as const,
  }));
  const native = [...new Set(slashCommands)]
    .filter(Boolean)
    .map((name) => ({
      name,
      description: t("Codex 原生指令"),
      key: `slash-${name}`,
      label: `/${name}`,
      value: `/${name} `,
      invocation: "/" as const,
    }));
  return [...skills, ...native];
}

export type ComposerEnterAction = "choose" | "submit" | "ignore";

export function composerEnterAction(
  paletteOpen: boolean,
  libraryLoading: boolean,
  itemCount: number,
  shiftKey: boolean,
): ComposerEnterAction {
  if (shiftKey) return "ignore";
  if (!paletteOpen) return "submit";
  return !libraryLoading && itemCount > 0 ? "choose" : "ignore";
}
