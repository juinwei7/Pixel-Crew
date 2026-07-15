export type BubbleRect = { left: number; top: number; right: number; bottom: number };

function intersects(a: BubbleRect, b: BubbleRect, padding = 6): boolean {
  return !(
    a.right + padding <= b.left ||
    a.left >= b.right + padding ||
    a.bottom + padding <= b.top ||
    a.top >= b.bottom + padding
  );
}

export function chooseBubblePlacement(
  baseX: number,
  baseBottom: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  occupied: BubbleRect[],
): { x: number; bottom: number; rect: BubbleRect } {
  const candidates: Array<[number, number]> = [
    [0, 0],
    [0, -height - 8],
    [-width * 0.62, -10],
    [width * 0.62, -10],
    [-width * 0.48, -height - 18],
    [width * 0.48, -height - 18],
    [0, -height * 2 - 16],
  ];
  let fallback: { x: number; bottom: number; rect: BubbleRect } | null = null;
  for (const [offsetX, offsetY] of candidates) {
    const x = Math.max(width / 2 + 6, Math.min(viewportWidth - width / 2 - 6, baseX + offsetX));
    const bottom = Math.max(height + 6, Math.min(viewportHeight - 6, baseBottom + offsetY));
    const rect = { left: x - width / 2, top: bottom - height, right: x + width / 2, bottom };
    const placement = { x, bottom, rect };
    fallback = placement;
    if (!occupied.some((other) => intersects(rect, other))) return placement;
  }
  return fallback!;
}
