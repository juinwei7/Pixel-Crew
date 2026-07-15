import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ProviderId } from "./providers/types.js";
import { assertSafeLocalPath } from "./safeLocalPath.js";

export type WorkflowLibraryUpdate = {
  workspacePath: string;
  provider: ProviderId;
  revision: number;
};

async function fingerprint(workspacePath: string, provider: ProviderId): Promise<string> {
  const root = provider === "claude"
    ? resolve(workspacePath, ".claude", "commands")
    : resolve(workspacePath, ".agents", "skills");
  await assertSafeLocalPath(workspacePath, root);
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (provider === "claude") await walk(path);
        else {
          const document = join(path, "SKILL.md");
          try {
            await assertSafeLocalPath(workspacePath, document);
            const info = await stat(document);
            files.push(`${relative(root, document).split(sep).join("/")}:${info.mtimeMs}:${info.size}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } else if (provider === "claude" && entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(path);
        files.push(`${relative(root, path).split(sep).join("/")}:${info.mtimeMs}:${info.size}`);
      }
    }));
  }

  await walk(root);
  return files.sort((left, right) => left.localeCompare(right)).join("|");
}

export class WorkflowLibraryWatcher {
  private readonly fingerprints = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(
    private readonly workspaces: () => string[],
    private readonly onUpdate: (update: WorkflowLibraryUpdate) => void,
    private readonly intervalMs = 1500,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.scanNow();
    this.timer = setInterval(() => void this.scanNow(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanNow(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const workspacePath of this.workspaces()) {
        for (const provider of ["claude", "codex"] as const) {
          const key = `${provider}\0${workspacePath}`;
          try {
            const next = await fingerprint(workspacePath, provider);
            const previous = this.fingerprints.get(key);
            this.fingerprints.set(key, next);
            if (previous === undefined || previous === next) continue;
            const revision = (this.revisions.get(key) ?? 0) + 1;
            this.revisions.set(key, revision);
            this.onUpdate({ workspacePath, provider, revision });
          } catch {
            // A transient filesystem error is reported by the editor on fetch.
            // Keep the previous fingerprint and retry on the next scan.
          }
        }
      }
    } finally {
      this.scanning = false;
    }
  }
}
