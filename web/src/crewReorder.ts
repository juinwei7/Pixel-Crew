// Pure helpers for drag-reordering the crew rail, extracted for testability.

/** Insertion index for a pointer at `y`, given each row's vertical midpoint. */
export function computeDropIndex(midYs: number[], y: number): number {
  let index = 0;
  for (const midY of midYs) {
    if (midY < y) index += 1;
  }
  return index;
}

/**
 * Vertical offset (in px) row `index` should shift by while row `from` is
 * being dragged toward insertion slot `insertIndex`, given a uniform row
 * size. Neighbours part to open a gap and the dragged row glides into it.
 */
export function reorderShift(index: number, from: number, insertIndex: number, size: number): number {
  if (from === -1) return 0;
  if (index === from) {
    if (insertIndex > from + 1) return (insertIndex - from - 1) * size;
    if (insertIndex < from) return (insertIndex - from) * size;
    return 0;
  }
  if (index > from && index < insertIndex) return -size;
  if (index >= insertIndex && index < from) return size;
  return 0;
}

/**
 * Move `id` so it lands at `insertIndex` (an index into the original list,
 * as produced by computeDropIndex). Returns the original array on a no-op.
 */
export function moveId(ids: string[], id: string, insertIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  const clamped = Math.max(0, Math.min(insertIndex, ids.length));
  // Dropping right before or right after itself leaves the order unchanged.
  if (clamped === from || clamped === from + 1) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(clamped > from ? clamped - 1 : clamped, 0, id);
  return next;
}
