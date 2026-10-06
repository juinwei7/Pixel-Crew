import { useEffect } from "react";
import { focusStudioShortcut } from "../focusStudios";
import { paneCycleShortcut } from "../focusPanes";
import { isCompositionKey } from "../keyboardInput";

type ShortcutHandlers = {
  onCommandPalette(): void;
  onToggleTaskLog(): void;
  onApproval(): void;
  onShortcutsHelp(): void;
  /** 接下一件：跳到下一位需要你的 NPC（needsYou.ts 的清單，循環）。 */
  onNextAttention?(): void;
  onEscape?(): void;
  onStudioShortcut?(index: number): boolean;
  onPaneCycle?(direction: 1 | -1): boolean;
};

export type KeyboardShortcut = "command_palette" | "toggle_task_log" | "approval" | "shortcuts_help" | "next_attention" | "escape";
export type DismissibleLayer = "command_palette" | "task_search" | "focus_mode";

export function topDismissibleLayer(commandPaletteOpen: boolean, taskSearchOpen: boolean, focusMode: boolean): DismissibleLayer | null {
  if (commandPaletteOpen) return "command_palette";
  if (taskSearchOpen) return "task_search";
  if (focusMode) return "focus_mode";
  return null;
}

export function keyboardShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey"> & { altKey?: boolean }, editable = false, terminal = false): KeyboardShortcut | null {
  // xterm owns its complete keyboard surface. Let Escape and command chords
  // reach the shell/TUI without also triggering Pixel Crew's global actions.
  if (terminal) return null;
  if (event.key === "Escape") return "escape";
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (command && key === "k") return "command_palette";
  if (editable) return null;
  if (!command && (event.key === "?" || (event.shiftKey && key === "/"))) return "shortcuts_help";
  if (command && !event.shiftKey && key === "j") return "toggle_task_log";
  if (command && event.shiftKey && key === "a") return "approval";
  // 單鍵 N（像 Gmail 的 j/k）：不在輸入框時才算，帶任何修飾鍵都不算。
  if (!command && !event.shiftKey && !event.altKey && key === "n") return "next_attention";
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
      if (event.defaultPrevented || isCompositionKey(event)) return;
      const editable = isEditable(event.target);
      const terminal = event.target instanceof HTMLElement && Boolean(event.target.closest(".black-window-terminal"));
      const studioIndex = focusStudioShortcut(event, editable);
      if (studioIndex !== null && handlers.onStudioShortcut?.(studioIndex)) {
        event.preventDefault();
        return;
      }
      const paneDirection = paneCycleShortcut(event, editable);
      if (paneDirection !== null && handlers.onPaneCycle?.(paneDirection)) {
        event.preventDefault();
        return;
      }
      const shortcut = keyboardShortcut(event, editable, terminal);
      if (!shortcut) return;
      if (shortcut === "next_attention" && !handlers.onNextAttention) return;
      if (shortcut !== "escape") event.preventDefault();
      if (shortcut === "command_palette") handlers.onCommandPalette();
      else if (shortcut === "toggle_task_log") handlers.onToggleTaskLog();
      else if (shortcut === "approval") handlers.onApproval();
      else if (shortcut === "shortcuts_help") handlers.onShortcutsHelp();
      else if (shortcut === "next_attention") handlers.onNextAttention?.();
      else handlers.onEscape?.();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [handlers]);
}
