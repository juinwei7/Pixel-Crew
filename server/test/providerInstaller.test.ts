import assert from "node:assert/strict";
import test from "node:test";
import { ProviderInstaller, providerInstallRecipe, refreshProviderPath } from "../src/providerInstaller.js";

test("uses fixed official standalone installers without npm", () => {
  const codexWindows = providerInstallRecipe("codex", "win32");
  assert.equal(codexWindows.file, "powershell.exe");
  assert.match(codexWindows.args.join(" "), /chatgpt\.com\/codex\/install\.ps1/);
  assert.doesNotMatch(codexWindows.displayCommand, /npm/);

  const codexLinux = providerInstallRecipe("codex", "linux");
  assert.equal(codexLinux.file, "/bin/sh");
  assert.match(codexLinux.args[1], /CODEX_NON_INTERACTIVE=1/);
  assert.match(codexLinux.args[1], /mktemp/);
  assert.match(codexLinux.args[1], /curl .* -o "\$tmp" &&/);
  assert.doesNotMatch(codexLinux.args[1], /curl[^|]+\|/);

  const claudeWindows = providerInstallRecipe("claude", "win32");
  assert.equal(claudeWindows.file, "winget.exe");
  assert.deepEqual(claudeWindows.args.slice(0, 4), ["install", "--id", "Anthropic.ClaudeCode", "--exact"]);
});

test("deduplicates a running provider installation and reports success", async () => {
  let executions = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const installer = new ProviderInstaller(
    () => {},
    async () => {
      executions++;
      await blocked;
      return { stdout: "installed", stderr: "" };
    },
    "linux",
  );

  const first = installer.start("codex");
  const second = installer.start("codex");
  assert.equal(first.status, "running");
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(executions, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(installer.get("codex").status, "succeeded");
  assert.equal(installer.get("codex").output, "installed");
});

test("reports bounded installer failures", async () => {
  let finished = false;
  const installer = new ProviderInstaller(
    () => { finished = true; },
    async () => { throw Object.assign(new Error("network unavailable"), { stderr: "download failed" }); },
    "linux",
  );
  installer.start("claude");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = installer.get("claude");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /network unavailable/);
  assert.equal(state.output, "download failed");
  assert.equal(finished, true);
});

test("refreshes known standalone install directories without duplicating PATH", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  refreshProviderPath("linux", env);
  const first = env.PATH;
  refreshProviderPath("linux", env);
  assert.equal(env.PATH, first);
  assert.match(env.PATH ?? "", /\.local\/bin/);
});
