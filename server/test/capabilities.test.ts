import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildClaudeMcpAddArgs, buildClaudeMcpRemoveArgs, CapabilityRegistry, parseMcpGetOutput, parseMcpList } from "../src/capabilities.js";
import { LocalStore } from "../src/store.js";
import { saveProjectCommand } from "../src/commandLibrary.js";

test("serves Claude built-in commands before runtime discovery or cache exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new CapabilityRegistry(store, () => undefined, "/fresh-repo");
    assert.equal(registry.getState().slashCommands.includes("mcp"), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty resumed-session meta frame does not erase discovered slash commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const updates: string[][] = [];
    const registry = new CapabilityRegistry(
      store,
      (state) => updates.push(state.slashCommands),
    );

    registry.mergeWorkerMeta({
      slashCommands: ["review", "verify"],
      mcpServers: [],
      toolCount: 2,
      builtinTools: [],
    });
    registry.mergeWorkerMeta({
      slashCommands: [],
      mcpServers: [],
      toolCount: 2,
      builtinTools: [],
    });

    assert.equal(updates.at(-1)?.includes("review"), true);
    assert.equal(updates.at(-1)?.includes("verify"), true);
    assert.equal(updates.at(-1)?.includes("mcp"), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh registry's builtinTools is null before any mergeWorkerMeta call", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new CapabilityRegistry(store, () => undefined, "/fresh-repo");
    assert.equal(registry.getState().builtinTools, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty resumed-session meta frame does not erase discovered builtin tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");
    registry.mergeWorkerMeta({ slashCommands: [], mcpServers: [], toolCount: 2, builtinTools: ["Bash", "Read"] });
    registry.mergeWorkerMeta({ slashCommands: [], mcpServers: [], toolCount: 2, builtinTools: [] });
    assert.deepEqual(registry.getState().builtinTools, ["Bash", "Read"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorkerMeta sorts and dedupes builtin tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");
    registry.mergeWorkerMeta({ slashCommands: [], mcpServers: [], toolCount: 2, builtinTools: ["Read", "Bash", "Read"] });
    assert.deepEqual(registry.getState().builtinTools, ["Bash", "Read"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps slash commands isolated by workspace registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const first = join(dir, "first");
  const second = join(dir, "second");
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    mkdirSync(first);
    mkdirSync(second);
    await saveProjectCommand(first, "first-only", "---\ndescription: First\n---\nDo first");
    await saveProjectCommand(second, "second-only", "---\ndescription: Second\n---\nDo second");
    const firstRegistry = new CapabilityRegistry(store, () => undefined, first);
    const secondRegistry = new CapabilityRegistry(store, () => undefined, second);
    await Promise.all([firstRegistry.refreshCommands(), secondRegistry.refreshCommands()]);
    assert.equal(firstRegistry.getState().slashCommands.includes("first-only"), true);
    assert.equal(firstRegistry.getState().slashCommands.includes("second-only"), false);
    assert.equal(secondRegistry.getState().slashCommands.includes("second-only"), true);
    assert.equal(secondRegistry.getState().slashCommands.includes("first-only"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serves cached Claude models immediately and merges later runtime discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    store.saveCapabilities("/repo", {
      slashCommands: [],
      mcpServers: [],
      models: [{ id: "cached-model", label: "Cached Model" }],
      toolCount: null,
      builtinTools: null,
      loading: false,
      source: "live",
      updatedAt: "2026-07-15T00:00:00.000Z",
      error: null,
    });
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");
    assert.equal(registry.getState().source, "cache");
    assert.equal(registry.getState().loading, true);
    assert.equal(registry.getState().models.some((model) => model.id === "cached-model"), true);
    assert.equal(registry.getState().models.some((model) => model.id === "sonnet"), true);

    registry.mergeWorkerMeta({ model: "runtime-model", slashCommands: [], mcpServers: [], toolCount: 1, builtinTools: [] });
    assert.equal(registry.getState().models.some((model) => model.id === "runtime-model"), true);

    const reopened = new CapabilityRegistry(store, () => undefined, "/repo");
    assert.equal(reopened.getState().models.some((model) => model.id === "runtime-model"), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collapses the CLI's full model id back to its alias instead of adding a duplicate option", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");

    registry.mergeWorkerMeta({ model: "claude-sonnet-5", slashCommands: [], mcpServers: [], toolCount: 1, builtinTools: [] });
    const models = registry.getState().models;
    assert.equal(models.filter((model) => model.id === "sonnet").length, 1);
    assert.equal(models.some((model) => model.id === "claude-sonnet-5"), false);

    registry.mergeWorkerMeta({ model: "claude-fable-5", slashCommands: [], mcpServers: [], toolCount: 1, builtinTools: [] });
    assert.equal(registry.getState().models.some((model) => model.id === "fable"), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collapses full model ids already persisted in the cache when loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    // Simulates a cache written before model-id normalization existed.
    store.saveCapabilities("/repo", {
      slashCommands: [],
      mcpServers: [],
      models: [{ id: "claude-fable-5", label: "claude-fable-5" }, { id: "claude-sonnet-5", label: "claude-sonnet-5" }],
      toolCount: null,
      builtinTools: null,
      loading: false,
      source: "live",
      updatedAt: "2026-07-15T00:00:00.000Z",
      error: null,
    });
    const models = new CapabilityRegistry(store, () => undefined, "/repo").getState().models;
    assert.equal(models.some((model) => model.id.startsWith("claude-")), false);
    assert.equal(models.filter((model) => model.id === "fable").length, 1);
    assert.equal(models.filter((model) => model.id === "sonnet").length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seeds native slash commands globally without leaking project commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {

    // A worker in one room discovers the built-in command set.
    const roomA = new CapabilityRegistry(store, () => undefined, "/repo-a");
    roomA.mergeWorkerMeta({ slashCommands: ["clear", "compact", "usage", "repo-a-only"], mcpServers: [], toolCount: 3, builtinTools: [] });
    assert.deepEqual(store.loadSlashCommandSeed(), ["clear", "compact", "usage"]);

    // A brand-new room (never messaged) still shows those native commands.
    const roomB = new CapabilityRegistry(store, () => undefined, "/repo-b");
    for (const name of ["clear", "compact", "usage"]) {
      assert.equal(roomB.getState().slashCommands.includes(name), true);
    }
    assert.equal(roomB.getState().slashCommands.includes("repo-a-only"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses claude mcp list statuses, including remote servers needing authentication", () => {
  const servers = parseMcpList([
    "fontrip: https://mcp.sre.fontrip.com/mcp - ✔ Connected",
    "Notion: https://mcp.notion.com/mcp - ! Needs authentication",
    "broken: /usr/local/bin/broken-server - ✘ Failed to connect",
    "teamtool: /usr/local/bin/teamtool - ⏸ Pending approval",
  ].join("\n"));

  assert.deepEqual(servers, [
    { name: "fontrip", status: "connected" },
    { name: "Notion", status: "needs_auth" },
    { name: "broken", status: "failed" },
    { name: "teamtool", status: "pending_approval" },
  ]);
});

test("distinguishes a connected-but-tools-fetch-failed server from a healthy connection", () => {
  // This text itself contains the word "Connected", so it must be checked
  // before the generic connected match or it silently looks healthy.
  const servers = parseMcpList([
    "flaky: https://mcp.example.com/mcp - ! Connected · tools fetch failed",
  ].join("\n"));

  assert.deepEqual(servers, [{ name: "flaky", status: "connected_tools_failed" }]);
});

test("parses `claude mcp get` detail for stdio, http, and account-level servers", () => {
  const stdio = parseMcpGetOutput([
    "my-hub:",
    "  Scope: User config (available in all your projects)",
    "  Status: ✔ Connected",
    "  Type: stdio",
    "  Command: /usr/bin/python",
    "  Args: -m gateway.hub_server",
    "  Environment:",
    "    PYTHONPATH=/repo",
    "",
    "To remove this server, run: claude mcp remove my-hub -s user",
  ].join("\n"));
  assert.deepEqual(stdio, {
    scope: "user",
    transport: "stdio",
    command: "/usr/bin/python",
    args: ["-m", "gateway.hub_server"],
    envKeys: ["PYTHONPATH"],
  });

  const http = parseMcpGetOutput([
    "orgpulse:",
    // Real CLI wording contains the word "project" even for local scope —
    // this must still resolve to "local", not "project" (regression check).
    "  Scope: Local config (private to you in this project)",
    "  Status: ✔ Connected",
    "  Type: http",
    "  URL: https://mcp.example.com",
    "  Headers:",
    "    X-Api-Key: super-secret-value",
    "",
    "To remove this server, run: claude mcp remove orgpulse -s local",
  ].join("\n"));
  assert.deepEqual(http, {
    scope: "local",
    transport: "http",
    url: "https://mcp.example.com",
    headerNames: ["X-Api-Key"],
  });
  // The header value must never survive parsing.
  assert.doesNotMatch(JSON.stringify(http), /super-secret-value/);

  const account = parseMcpGetOutput([
    "claude.ai Gmail:",
    "  Scope: claude.ai config",
    "  Status: ✔ Connected",
  ].join("\n"));
  assert.deepEqual(account, { scope: "account" });

  const project = parseMcpGetOutput([
    "teamtool:",
    "  Scope: Project config (shared via .mcp.json)",
    "  Status: ⏸ Pending approval (run `claude` to approve)",
    "  Type: stdio",
    "  Command: /bin/echo",
    "  Args: hello",
  ].join("\n"));
  assert.deepEqual(project, { scope: "project", transport: "stdio", command: "/bin/echo", args: ["hello"] });
});

test("mergeWorkerMeta shallow-merges so an init frame's {name,status} does not erase refresh()-derived scope/transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-capabilities-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new CapabilityRegistry(store, () => undefined, "/repo");
    // Simulate what refresh() would have populated from `mcp get`.
    registry.mergeWorkerMeta({
      slashCommands: [],
      mcpServers: [{ name: "my-hub", status: "connected", scope: "user", transport: "stdio" }],
      toolCount: 1,
      builtinTools: [],
    });
    // A later init frame only ever reports {name, status}.
    registry.mergeWorkerMeta({
      slashCommands: [],
      mcpServers: [{ name: "my-hub", status: "connected" }],
      toolCount: 1,
      builtinTools: [],
    });
    const server = registry.getState().mcpServers.find((s) => s.name === "my-hub");
    assert.equal(server?.scope, "user");
    assert.equal(server?.transport, "stdio");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("builds claude mcp add args for stdio, http, and add-json modes", () => {
  // Argument order here is load-bearing, not stylistic: `-e`/`-H` are
  // variadic and will swallow <name>/<url> if those positionals come after
  // them (verified against the real CLI — see buildClaudeMcpAddArgs).
  assert.deepEqual(
    buildClaudeMcpAddArgs({ name: "my-hub", scope: "local", mode: "form", transport: "stdio", localArgv: ["npx", "server"], env: ["KEY=value"] }),
    ["mcp", "add", "-s", "local", "my-hub", "-t", "stdio", "-e", "KEY=value", "--", "npx", "server"],
  );
  assert.deepEqual(
    buildClaudeMcpAddArgs({ name: "remote", scope: "project", mode: "form", transport: "http", target: "https://mcp.example.com", headers: ["Authorization: Bearer x"] }),
    ["mcp", "add", "-s", "project", "remote", "https://mcp.example.com", "-t", "http", "-H", "Authorization: Bearer x"],
  );
  assert.deepEqual(
    buildClaudeMcpAddArgs({ name: "pasted", scope: "user", mode: "json", json: '{"command":"npx"}' }),
    ["mcp", "add-json", "pasted", '{"command":"npx"}', "-s", "user"],
  );
});

test("builds claude mcp add args with the advanced OAuth options (callback-port, client-id)", () => {
  assert.deepEqual(
    buildClaudeMcpAddArgs({
      name: "remote", scope: "local", mode: "form", transport: "http", target: "https://mcp.example.com",
      headers: [], callbackPort: "5555", clientId: "my-client-123",
    }),
    ["mcp", "add", "-s", "local", "remote", "https://mcp.example.com", "-t", "http", "--callback-port", "5555", "--client-id", "my-client-123"],
  );
  // Omitted when not provided — no empty flags sent to the CLI.
  assert.deepEqual(
    buildClaudeMcpAddArgs({ name: "remote", scope: "local", mode: "form", transport: "http", target: "https://mcp.example.com" }),
    ["mcp", "add", "-s", "local", "remote", "https://mcp.example.com", "-t", "http"],
  );
});

test("builds claude mcp remove args with the selected configuration scope", () => {
  assert.deepEqual(buildClaudeMcpRemoveArgs("teamtool", "project"), ["mcp", "remove", "teamtool", "-s", "project"]);
  assert.deepEqual(buildClaudeMcpRemoveArgs("legacy"), ["mcp", "remove", "legacy"]);
});
