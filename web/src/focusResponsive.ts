export const FOCUS_READER_BREAKPOINTS = {
  wide: 1500,
  stacked: 1240,
  headerWrap: 840,
  phone: 700,
} as const;

export type FocusReaderLayout = "four_column" | "three_column" | "stacked" | "stacked_compact" | "phone";

/** Mirrors the Focus Reader CSS matrix so its threshold behavior is testable. */
export function focusReaderLayout(viewportWidth: number): FocusReaderLayout {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= FOCUS_READER_BREAKPOINTS.phone) return "phone";
  if (viewportWidth <= FOCUS_READER_BREAKPOINTS.headerWrap) return "stacked_compact";
  if (viewportWidth <= FOCUS_READER_BREAKPOINTS.stacked) return "stacked";
  if (viewportWidth < FOCUS_READER_BREAKPOINTS.wide) return "three_column";
  return "four_column";
}
