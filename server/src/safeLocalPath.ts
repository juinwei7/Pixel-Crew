import { lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { t } from "./i18n.js";

/**
 * Reject paths that escape the workspace or traverse an existing symlink.
 * The API resolves workspaces up front, so checking each existing component
 * keeps project-local editors from following links outside that workspace.
 */
export async function assertSafeLocalPath(workspacePath: string, targetPath: string): Promise<void> {
  const workspace = resolve(workspacePath);
  const target = resolve(targetPath);
  const relativeTarget = relative(workspace, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error(t("目標路徑超出工作資料夾"));
  }

  let current = workspace;
  const components = relativeTarget ? relativeTarget.split(sep) : [];
  for (const component of components) {
    current = resolve(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(t("工作路徑不能包含符號連結"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * Synchronous, zero-I/O containment check: does `targetPath` (absolute or
 * relative to the workspace) resolve to somewhere OUTSIDE the workspace?
 * Used as a write-fence on NPC file tools where the async lstat walk above is
 * awkward to inline (the approval bridge callback must stay sync to preserve
 * its `null` dispatch). Path-normalization only — pairs with channel F's
 * symlink read-fence rather than replacing the full lstat walk.
 */
export function pathEscapesWorkspace(workspacePath: string, targetPath: string): boolean {
  const workspace = resolve(workspacePath);
  const target = resolve(workspace, targetPath);
  const rel = relative(workspace, target);
  return rel === ".." || rel.startsWith(`..${sep}`);
}
