/** Office growth level unlocked by the team's all-time completed turns. */
export function milestoneLevel(completedTurns: number): 0 | 1 | 2 | 3 {
  if (completedTurns >= 300) return 3;
  if (completedTurns >= 100) return 2;
  if (completedTurns >= 25) return 1;
  return 0;
}
