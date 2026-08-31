import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { McpConfigWatcher, mcpConfigTargets, type McpConfigChange } from "../src/mcpConfigWatcher.js";

test("builds global and workspace MCP configuration targets without duplicates", () => {
  const targets = mcpConfigTargets(["/repo", "/repo"], {
    homeDirectory: "/home/tester",
    codexHome: "/config/codex",
  });
  const repo = resolve("/repo");
  assert.deepEqual(
    targets.map(({ provider, workspacePath, path, scope, section }) => ({ provider, workspacePath, path, scope, section })),
    [
      { provider: "claude", workspacePath: null, path: join("/home/tester", ".claude.json"), scope: "global", section: "claude-global" },
      { provider: "codex", workspacePath: null, path: join("/config/codex", "config.toml"), scope: "global", section: "file" },
      { provider: "claude", workspacePath: repo, path: join("/home/tester", ".claude.json"), scope: "workspace", section: "claude-project" },
      { provider: "claude", workspacePath: repo, path: join(repo, ".mcp.json"), scope: "workspace", section: "file" },
      { provider: "codex", workspacePath: repo, path: join(repo, ".codex", "config.toml"), scope: "workspace", section: "file" },
    ],
  );
});

test("an explicit claudeHome overrides homeDirectory for both Claude targets, independent of codexHome", () => {
  const targets = mcpConfigTargets(["/repo"], {
    homeDirectory: "/home/tester",
    codexHome: "/config/codex",
    claudeHome: "/config/claude",
  });
  const claudeTargets = targets.filter((target) => target.provider === "claude" && target.section !== "file");
  assert.deepEqual(
    claudeTargets.map(({ path, scope }) => ({ path, scope })),
    [
      { path: join("/config/claude", ".claude.json"), scope: "global" },
      { path: join("/config/claude", ".claude.json"), scope: "workspace" },
    ],
  );
  // codexHome must not leak into the Claude targets, and vice versa.
  assert.equal(targets.some((t) => t.path.includes("/config/codex")), true);
});

test("ignores Claude session telemetry and watches only MCP-relevant sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-crew-claude-watch-"));
  const home = join(root, "home");
  const workspace = join(root, "repo");
  const codexHome = join(home, ".codex");
  await mkdir(workspace);
  await mkdir(codexHome, { recursive: true });
  const claudeConfig = join(home, ".claude.json");
  const initial = {
    numStartups: 1,
    mcpServers: {},
    projects: {
      [workspace]: {
        lastSessionId: "one",
        lastCost: 1,
        mcpServers: {},
        enabledMcpjsonServers: [],
      },
    },
  };
  await writeFile(claudeConfig, JSON.stringify(initial));
  const changes: McpConfigChange[] = [];
  const watcher = new McpConfigWatcher(
    () => [workspace],
    (change) => { changes.push(change); },
    { homeDirectory: home, codexHome },
  );
  try {
    await watcher.initialize();
    await writeFile(claudeConfig, JSON.stringify({
      ...initial,
      numStartups: 2,
      projects: {
        [workspace]: { ...initial.projects[workspace], lastSessionId: "two", lastCost: 5 },
      },
    }));
    await watcher.checkNow();
    assert.equal(changes.length, 0);

    await writeFile(claudeConfig, JSON.stringify({
      ...initial,
      mcpServers: { globalHub: { command: "hub" } },
    }));
    await watcher.checkNow();
    assert.deepEqual(changes.map((change) => [change.scope, change.section]), [["global", "claude-global"]]);

    await writeFile(claudeConfig, JSON.stringify({
      ...initial,
      mcpServers: { globalHub: { command: "hub" } },
      projects: {
        [workspace]: {
          ...initial.projects[workspace],
          enabledMcpjsonServers: ["projectHub"],
        },
      },
    }));
    await watcher.checkNow();
    assert.deepEqual(changes.at(-1) && [changes.at(-1)!.scope, changes.at(-1)!.section], ["workspace", "claude-project"]);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("initial snapshot is silent, then detects create, replace, and delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-crew-mcp-watch-"));
  const home = join(root, "home");
  const workspace = join(root, "repo");
  const codexHome = join(home, ".codex");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(codexHome, { recursive: true })]);
  const changes: McpConfigChange[] = [];
  const watcher = new McpConfigWatcher(
    () => [workspace],
    (change) => { changes.push(change); },
    { homeDirectory: home, codexHome },
  );
  try {
    await watcher.initialize();
    assert.equal(changes.length, 0);

    const projectConfig = join(workspace, ".mcp.json");
    await writeFile(projectConfig, '{"mcpServers":{"hub":{}}}');
    await watcher.checkNow();
    assert.deepEqual(changes.map((change) => [change.provider, change.scope]), [["claude", "workspace"]]);

    await writeFile(projectConfig, '{"mcpServers":{"hub2":{}}}');
    await watcher.checkNow();
    assert.equal(changes.length, 2);

    await rm(projectConfig);
    await watcher.checkNow();
    assert.equal(changes.length, 3);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a change arriving during synchronization is checked again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-crew-mcp-watch-rerun-"));
  const home = join(root, "home");
  const workspace = join(root, "repo");
  const codexHome = join(home, ".codex");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(codexHome, { recursive: true })]);
  const configPath = join(codexHome, "config.toml");
  await writeFile(configPath, "[mcp_servers.one]\n");
  let releaseFirstChange!: () => void;
  const firstChangeBlocked = new Promise<void>((resolve) => { releaseFirstChange = resolve; });
  const seen: string[] = [];
  const watcher = new McpConfigWatcher(
    () => [workspace],
    async (change) => {
      seen.push(change.path);
      if (seen.length === 1) await firstChangeBlocked;
    },
    { homeDirectory: home, codexHome },
  );
  try {
    await watcher.initialize();
    await writeFile(configPath, "[mcp_servers.two]\n");
    const firstCheck = watcher.checkNow();
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(configPath, "[mcp_servers.three]\n");
    const queuedCheck = watcher.checkNow();
    releaseFirstChange();
    await Promise.all([firstCheck, queuedCheck]);
    assert.equal(seen.length, 2);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});
