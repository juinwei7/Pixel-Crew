import { useEffect } from "react";

type ShortcutHandlers = {
  onCommandPalette(): void;
  onToggleTaskLog(): void;
  onApproval(): void;
  onShortcutsHelp(): void;
  onEscape?(): void;
};

export type KeyboardShortcut = "command_palette" | "toggle_task_log" | "approval" | "shortcuts_help" | "escape";
export type DismissibleLayer = "command_palette" | "task_search" | "focus_mode";

export function topDismissibleLayer(commandPaletteOpen: boolean, taskSearchOpen: boolean, focusMode: boolean): DismissibleLayer | null {
  if (commandPaletteOpen) return "command_palette";
  if (taskSearchOpen) return "task_search";
  if (focusMode) return "focus_mode";
  return null;
}

export function keyboardShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">, editable = false): KeyboardShortcut | null {
  if (event.key === "Escape") return "escape";
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (command && key === "k") return "command_palette";
  if (editable) return null;
  if (!command && (event.key === "?" || (event.shiftKey && key === "/"))) return "shortcuts_help";
  if (command && !event.shiftKey && key === "j") return "toggle_task_log";
  if (command && event.shiftKey && key === "a") return "approval";
  return null;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const shortcut = keyboardShortcut(event, isEditable(event.target));
      if (!shortcut) return;
      if (shortcut !== "escape") event.preventDefault();
      if (shortcut === "command_palette") handlers.onCommandPalette();
      else if (shortcut === "toggle_task_log") handlers.onToggleTaskLog();
      else if (shortcut === "approval") handlers.onApproval();
      else if (shortcut === "shortcuts_help") handlers.onShortcutsHelp();
      else handlers.onEscape?.();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [handlers]);
}
