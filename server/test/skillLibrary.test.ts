import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteProjectSkill, listProjectSkills, saveProjectSkill, skillMetadata } from "../src/skillLibrary.js";

test("manages repo skills and preserves supporting assets when renamed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-skills-"));
  try {
    const content = "---\nname: review-code\ndescription: Review code changes\n---\n\nReview the current diff.";
    assert.deepEqual(skillMetadata(content), { name: "review-code", description: "Review code changes" });
    await saveProjectSkill(workspace, "review-code", content);
    const assetDir = join(workspace, ".agents", "skills", "review-code", "references");
    mkdirSync(assetDir);
    writeFileSync(join(assetDir, "checklist.md"), "keep me");

    const renamed = content.replaceAll("review-code", "review-final");
    await saveProjectSkill(workspace, "review-final", renamed, "review-code");
    assert.equal(readFileSync(join(workspace, ".agents", "skills", "review-final", "references", "checklist.md"), "utf8"), "keep me");
    assert.deepEqual((await listProjectSkills(workspace)).map((skill) => skill.name), ["review-final"]);
    await deleteProjectSkill(workspace, "review-final");
    assert.deepEqual(await listProjectSkills(workspace), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validates skill names and required frontmatter", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-skills-"));
  try {
    await assert.rejects(() => saveProjectSkill(workspace, "../bad", "hello"), /name|名稱|路徑/);
    await assert.rejects(
      () => saveProjectSkill(workspace, "valid", "---\nname: other\ndescription: test\n---\nbody"),
      /name 必須/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("does not follow skill directories linked outside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pixel-crew-skills-"));
  const external = mkdtempSync(join(tmpdir(), "pixel-crew-external-"));
  try {
    mkdirSync(join(workspace, ".agents"));
    symlinkSync(external, join(workspace, ".agents", "skills"), process.platform === "win32" ? "junction" : "dir");
    const content = "---\nname: safe-skill\ndescription: Must remain local\n---\n\nDo work.";
    await assert.rejects(() => listProjectSkills(workspace), /符號連結/);
    await assert.rejects(() => saveProjectSkill(workspace, "safe-skill", content), /符號連結/);
    assert.equal(existsSync(join(external, "safe-skill")), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
