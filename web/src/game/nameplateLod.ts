// When to show an NPC's DOM nameplate. With a normal crew every tag shows as
// before. Once the office holds a big crew and the camera is zoomed out to fit
// the extended floor, idle tags step back so they don't pile into a wall of
// labels — only the ones that matter stay: busy, selected, hovered.

export type NameplateContext = {
  /** Screen position of the NPC (px, relative to the canvas). */
  x: number;
  y: number;
  viewWidth: number;
  viewHeight: number;
  /** Camera zoom (art px → screen px). */
  scale: number;
  /** NPCs currently in the scene. */
  crowd: number;
  /** Busy, selected, hovered or waiting on the owner — always labelled. */
  important: boolean;
};

/** Below this zoom a big crew's idle tags are hidden. */
export const DECLUTTER_SCALE = 1.75;
/** …and only when there are more NPCs than this. */
export const DECLUTTER_CROWD = 16;

export function nameplateVisible(c: NameplateContext): boolean {
  // Tags of NPCs scrolled off screen would hang over the UI at the edges.
  const pad = 40;
  if (c.x < -pad || c.x > c.viewWidth + pad || c.y < -pad || c.y > c.viewHeight + pad) return false;
  if (c.important) return true;
  return !(c.scale < DECLUTTER_SCALE && c.crowd > DECLUTTER_CROWD);
}

export type NameplateBox = {
  id: string;
  /** Tag centre x and top y (screen px). */
  x: number;
  top: number;
  width: number;
  height: number;
  /** Higher wins a spot first (selected > hovered > busy > idle). */
  priority: number;
};

/**
 * Crowded and zoomed out: of the tags that may show, keep the most important
 * ones and drop any that would overlap a tag already kept. Greedy, O(n²) on
 * the visible tags only (a few dozen at most). Returns the ids to show.
 */
export function declutterNameplates(boxes: NameplateBox[], gap = 2): Set<string> {
  const kept: NameplateBox[] = [];
  const order = [...boxes].sort((a, b) => b.priority - a.priority);
  for (const box of order) {
    const clash = kept.some((k) =>
      Math.abs(k.x - box.x) * 2 < k.width + box.width + gap * 2 &&
      box.top < k.top + k.height + gap && k.top < box.top + box.height + gap,
    );
    if (!clash) kept.push(box);
  }
  return new Set(kept.map((box) => box.id));
}

/** Declutter mode is on: big crew and the camera zoomed out. */
export function crowdedView(scale: number, crowd: number): boolean {
  return scale < DECLUTTER_SCALE && crowd > DECLUTTER_CROWD;
}
