import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeLocalPath } from "./safeLocalPath.js";
import { frontmatterText, workflowFrontmatter } from "./workflowDocument.js";
import { protectFile } from "./platform/fileProtection.js";
import { t } from "./i18n.js";

export type CommandDocument = {
  name: string;
  description: string;
  argumentHint: string;
  allowedTools: string;
  model: string;
  content: string;
  updatedAt: string;
};

const MAX_COMMAND_BYTES = 200_000;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

function commandsRoot(workspacePath: string): string {
  return resolve(workspacePath, ".claude", "commands");
}

function commandPath(workspacePath: string, name: string): string {
  const normalized = name.trim();
  if (!COMMAND_NAME.test(normalized) || normalized.length > 120) {
    throw new Error(t("指令名稱只能使用英數、-、_、.，並可用 / 分類"));
  }
  const root = commandsRoot(workspacePath);
  const path = resolve(root, `${normalized}.md`);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(t("指令路徑不合法"));
  return path;
}

export function commandMetadata(content: string): Pick<CommandDocument, "description" | "argumentHint" | "allowedTools" | "model"> {
  const metadata = workflowFrontmatter(content);
  return {
    description: frontmatterText(metadata.description),
    argumentHint: frontmatterText(metadata["argument-hint"] ?? metadata.argument_hint),
    allowedTools: frontmatterText(metadata["allowed-tools"] ?? metadata.allowed_tools),
    model: frontmatterText(metadata.model),
  };
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }));
  }
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

export async function listProjectCommands(workspacePath: string): Promise<CommandDocument[]> {
  const root = commandsRoot(workspacePath);
  await assertSafeLocalPath(workspacePath, root);
  const files = await markdownFiles(root);
  return Promise.all(files.map(async (path) => {
    const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const name = relative(root, path).slice(0, -3).split(sep).join("/");
    return {
      name,
      ...commandMetadata(content),
      content,
      updatedAt: info.mtime.toISOString(),
    };
  }));
}

export async function saveProjectCommand(
  workspacePath: string,
  name: string,
  content: string,
  originalName?: string,
): Promise<CommandDocument> {
  if (!content.trim()) throw new Error(t("指令內容不能是空白"));
  if (Buffer.byteLength(content, "utf8") > MAX_COMMAND_BYTES) throw new Error(t("指令內容不能超過 200 KB"));
  commandMetadata(content);
  const path = commandPath(workspacePath, name);
  const oldPath = originalName ? commandPath(workspacePath, originalName) : null;
  await assertSafeLocalPath(workspacePath, path);
  if (oldPath) await assertSafeLocalPath(workspacePath, oldPath);
  if (!oldPath || oldPath !== path) {
    try {
      await stat(path);
      throw new Error(t("/{name} 已經存在", { name }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeLocalPath(workspacePath, path);
  const temporary = `${path}.pixel-crew-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await protectFile(path);
  if (oldPath && oldPath !== path) await rm(oldPath, { force: true });
  const [saved] = (await listProjectCommands(workspacePath)).filter((command) => command.name === name);
  if (!saved) throw new Error(t("指令儲存後無法讀取"));
  return saved;
}

export async function deleteProjectCommand(workspacePath: string, name: string): Promise<void> {
  const path = commandPath(workspacePath, name);
  await assertSafeLocalPath(workspacePath, path);
  await rm(path, { force: true });
}
