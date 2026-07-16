export type PaletteEntry = { name: string; description: string; argumentHint?: string };

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
    .map((name) => ({ name, description: "Claude 指令" }));
  return [...library, ...extra];
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
