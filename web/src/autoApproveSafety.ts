import type { AutoApproveMode } from "./types";

/**
 * Entering the unrestricted mode is intentionally frictionful. Re-selecting
 * the mode is harmless, and moving to any more restrictive mode must stay
 * immediate so a user can regain approval prompts without another obstacle.
 */
export function requiresAutoApproveConfirmation(current: AutoApproveMode, next: AutoApproveMode): boolean {
  return next === "invincible" && current !== "invincible";
}
