type FormatElapsedOptions = {
  padMinutes?: boolean;
};

/** Formats an elapsed duration in whole seconds for compact live-status UI. */
export function formatElapsed(seconds: number, { padMinutes = false }: FormatElapsedOptions = {}): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const minuteLabel = padMinutes ? String(minutes).padStart(2, "0") : String(minutes);
  return `${minuteLabel}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
