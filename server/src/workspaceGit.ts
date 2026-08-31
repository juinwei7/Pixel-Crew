import { execCli, type ExecCliResult } from "./platform/processes.js";

export type WorkspaceGitSummary = {
  workspacePath: string;
  available: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: number;
  ahead: number | null;
  behind: number | null;
  message: string | null;
};

type RunCli = (command: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }) => Promise<ExecCliResult>;

const gitOptions = (workspacePath: string) => ({ cwd: workspacePath, timeout: 5_000, maxBuffer: 200_000 });

function changedFileCount(status: string): number {
  return status.split(/\r?\n/).filter(Boolean).length;
}

function aheadBehind(value: string): { ahead: number; behind: number } | null {
  const [behindValue, aheadValue] = value.trim().split(/\s+/);
  const behind = Number(behindValue);
  const ahead = Number(aheadValue);
  return Number.isInteger(ahead) && ahead >= 0 && Number.isInteger(behind) && behind >= 0 ? { ahead, behind } : null;
}

/**
 * Reads a small, presentation-safe Git summary. Every command is fixed and
 * read-only; callers are responsible for authorizing the workspace path first.
 */
export async function readWorkspaceGitSummary(workspacePath: string, runCli: RunCli = execCli): Promise<WorkspaceGitSummary> {
  try {
    const [branch, head, status] = await Promise.all([
      runCli("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOptions(workspacePath)),
      runCli("git", ["rev-parse", "--short", "HEAD"], gitOptions(workspacePath)),
      runCli("git", ["status", "--porcelain"], gitOptions(workspacePath)),
    ]);
    let ahead: number | null = null;
    let behind: number | null = null;
    try {
      const upstream = await runCli("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], gitOptions(workspacePath));
      const parsed = aheadBehind(upstream.stdout);
      ahead = parsed?.ahead ?? null;
      behind = parsed?.behind ?? null;
    } catch {
      // A repository may intentionally have no upstream. This is not an error.
    }
    const currentBranch = branch.stdout.trim();
    return {
      workspacePath,
      available: true,
      branch: currentBranch === "HEAD" ? "detached HEAD" : currentBranch || null,
      head: head.stdout.trim() || null,
      changedFiles: changedFileCount(status.stdout),
      ahead,
      behind,
      message: null,
    };
  } catch {
    return {
      workspacePath,
      available: false,
      branch: null,
      head: null,
      changedFiles: 0,
      ahead: null,
      behind: null,
      message: "Git 狀態目前無法讀取",
    };
  }
}

export const workspaceGitInternals = { changedFileCount, aheadBehind };
