const MIN_AUTO_FIT_SCALE = 2;
const MAX_AUTO_FIT_SCALE = 2.75;
const MIN_COMFORTABLE_WIDTH = 1_024;
const MAX_COMFORTABLE_WIDTH = 1_920;

/**
 * Browser-width-led default camera distance.
 *
 * Application panels are overlays and never participate in this calculation.
 * The upper bound keeps a large desktop from turning the office into an
 * uncomfortable close-up.
 */
export function responsiveOfficeFitScale(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return MIN_AUTO_FIT_SCALE;
  const progress = Math.max(
    0,
    Math.min(1, (viewportWidth - MIN_COMFORTABLE_WIDTH) / (MAX_COMFORTABLE_WIDTH - MIN_COMFORTABLE_WIDTH)),
  );
  return MIN_AUTO_FIT_SCALE + (MAX_AUTO_FIT_SCALE - MIN_AUTO_FIT_SCALE) * progress;
}

/**
 * How far the user may zoom out. A normal office keeps the crisp 2x floor; a
 * big crew (floor extended with the annex) may go down to 1x so the whole
 * floor clears the side panels, which overlay the canvas. NPC name tags are
 * DOM text at a fixed size, so they stay readable at any zoom.
 */
export function officeMinScale(floorHeight: number, baseHeight: number): number {
  return floorHeight <= baseHeight ? 2 : 1;
}
