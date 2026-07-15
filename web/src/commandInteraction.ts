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
