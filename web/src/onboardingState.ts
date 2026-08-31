// Kept outside the dialog component so the first-launch check does not pull
// the complete onboarding UI into the initial application bundle.
export const TOUR_DONE_KEY = "pixel-crew:onboarding-tour-done";

export function hasSeenTour(): boolean {
  try { return localStorage.getItem(TOUR_DONE_KEY) === "1"; } catch { return true; }
}
