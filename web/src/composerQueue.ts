import type { ComposerDocument, ComposerImage } from "./composerFiles";

export type QueuedCommand = { id: string; text: string; images: ComposerImage[]; documents: ComposerDocument[]; clientMessageId: string; idempotencyKey: string };

export const MAX_QUEUED_COMMANDS = 10;

export function moveQueuedItem<T>(items: T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function reorderQueuedItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function mergeComposerItems<T extends { id: string }>(saved: T[], current: T[]): T[] {
  const merged = new Map(saved.map((item) => [item.id, item]));
  for (const item of current) merged.set(item.id, item);
  return [...merged.values()];
}

export function newQueueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
