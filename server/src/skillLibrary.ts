import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertSafeLocalPath } from "./safeLocalPath.js";
import { frontmatterText, workflowFrontmatter } from "./workflowDocument.js";
import { protectFile } from "./platform/fileProtection.js";
import { t } from "./i18n.js";

export type SkillDocument = {
  name: string;
  description: string;
  content: string;
  updatedAt: string;
};

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SKILL_BYTES = 300_000;

function skillsRoot(workspacePath: string): string {
  return resolve(workspacePath, ".agents", "skills");
}

function skillDirectory(workspacePath: string, name: string): string {
  const normalized = name.trim();
  if (!SKILL_NAME.test(normalized)) {
    throw new Error(t("Skill 名稱只能使用小寫英數、-、_，最多 64 個字元"));
  }
  const root = skillsRoot(workspacePath);
  const path = resolve(root, normalized);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(t("Skill 路徑不合法"));
  return path;
}

export function skillMetadata(content: string): { name: string; description: string } {
  const metadata = workflowFrontmatter(content);
  return {
    name: frontmatterText(metadata.name),
    description: frontmatterText(metadata.description),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function listProjectSkills(workspacePath: string): Promise<SkillDocument[]> {
  const root = skillsRoot(workspacePath);
  await assertSafeLocalPath(workspacePath, root);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
    .map(async (entry): Promise<SkillDocument | null> => {
      const path = join(root, entry.name, "SKILL.md");
      try {
        await assertSafeLocalPath(workspacePath, path);
        const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        return {
          name: entry.name,
          description: skillMetadata(content).description,
          content,
          updatedAt: info.mtime.toISOString(),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }));
  return skills.filter((skill): skill is SkillDocument => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveProjectSkill(
  workspacePath: string,
  name: string,
  content: string,
  originalName?: string,
): Promise<SkillDocument> {
  if (!content.trim()) throw new Error(t("Skill 內容不能是空白"));
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error(t("Skill 內容不能超過 300 KB"));
  const metadata = skillMetadata(content);
  if (metadata.name !== name.trim()) throw new Error(t("SKILL.md frontmatter 的 name 必須和資料夾名稱相同"));
  if (!metadata.description) throw new Error(t("SKILL.md 必須提供 description"));

  const path = skillDirectory(workspacePath, name);
  const oldPath = originalName ? skillDirectory(workspacePath, originalName) : null;
  await assertSafeLocalPath(workspacePath, path);
  if (oldPath) {
    await assertSafeLocalPath(workspacePath, oldPath);
    await assertSafeLocalPath(workspacePath, join(oldPath, "SKILL.md"));
  }
  if (!oldPath && await exists(path)) throw new Error(t("Skill {name} 已經存在", { name }));
  if (oldPath && oldPath !== path) {
    if (await exists(path)) throw new Error(t("Skill {name} 已經存在", { name }));
    const root = dirname(path);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertSafeLocalPath(workspacePath, root);
    const staging = join(root, `.pixel-crew-skill-${process.pid}-${Date.now()}`);
    try {
      await cp(oldPath, staging, { recursive: true, force: false, errorOnExist: true });
      await rm(join(staging, "SKILL.md"), { force: true });
      await writeFile(join(staging, "SKILL.md"), content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await protectFile(join(staging, "SKILL.md"));
      await rename(staging, path);
      try {
        await rm(oldPath, { recursive: true });
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      const saved = (await listProjectSkills(workspacePath)).find((skill) => skill.name === name);
      if (!saved) throw new Error(t("Skill 儲存後無法讀取"));
      return saved;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertSafeLocalPath(workspacePath, join(path, "SKILL.md"));
  const documentPath = join(path, "SKILL.md");
  const temporary = `${documentPath}.pixel-crew-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, documentPath);
  await protectFile(documentPath);
  const saved = (await listProjectSkills(workspacePath)).find((skill) => skill.name === name);
  if (!saved) throw new Error("Skill 儲存後無法讀取");
  return saved;
}

export async function deleteProjectSkill(workspacePath: string, name: string): Promise<void> {
  const path = skillDirectory(workspacePath, name);
  await assertSafeLocalPath(workspacePath, path);
  await rm(path, { recursive: true, force: true });
}
