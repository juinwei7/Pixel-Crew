import { resolveExecutable } from "../platform/processes.js";

const MAX_SNIPPET = 500;

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

// Surfaces exactly what the auth check actually ran and saw, so a machine
// where detection is wrong (CLI is really logged in, but Pixel Crew disagrees)
// can be diagnosed from the resolved binary path and raw CLI output instead
// of guessed at — PATH resolution and CLI output format vary a lot machine to
// machine (see CLAUDE.md's "CLI behavior is empirical" note).
export function buildAuthDebug(params: {
  command: string;
  args: string[];
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException | null;
}): string {
  const { command, args, durationMs, stdout = "", stderr = "", error } = params;
  const resolved = resolveExecutable(command);
  const lines = [
    `resolved executable: ${resolved}`,
    `command: ${resolved} ${args.join(" ")}`,
    `duration: ${durationMs}ms`,
    `exit: ${error ? String(error.code ?? "unknown") : "0"}`,
  ];
  if (error?.message) lines.push(`error: ${truncate(error.message)}`);
  if (stdout.trim()) lines.push(`stdout: ${truncate(stdout)}`);
  if (stderr.trim()) lines.push(`stderr: ${truncate(stderr)}`);
  return lines.join("\n");
}
