export type DiscussionMode = "roundtable" | "warroom" | null;

/**
 * The composer has one discussion slot: selecting one workflow replaces the
 * other, while selecting the active workflow turns it off.
 */
export function toggleDiscussionMode(current: DiscussionMode, requested: Exclude<DiscussionMode, null>): DiscussionMode {
  return current === requested ? null : requested;
}

/** Empty messages always stay on the normal composer path. */
export function discussionSubmission(mode: DiscussionMode, text: string): Exclude<DiscussionMode, null> | "normal" {
  return text.trim() && mode ? mode : "normal";
}
