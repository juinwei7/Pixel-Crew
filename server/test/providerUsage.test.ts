import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountUsageRegistry, normalizeCodexUsage, parseClaudeUsage, ProviderUsageRegistry } from "../src/providerUsage.js";
import { LocalStore } from "../src/store.js";

test("parses Claude /usage JSON into account-wide remaining energy", () => {
  const raw = JSON.stringify({
    result: [
      "Current session: 20% used · resets Jul 16 at 2am (Asia/Taipei)",
      "Current week (all models): 73% used · resets Jul 16 at 8pm (Asia/Taipei)",
      "Current week (Fable): 100% used · resets Jul 18 at 8pm (Asia/Taipei)",
    ].join("\n"),
  });

  assert.deepEqual(parseClaudeUsage(raw).map(({ label, remainingPercent, scope }) => ({ label, remainingPercent, scope })), [
    { label: "本次時段", remainingPercent: 80, scope: "session" },
    { label: "本週", remainingPercent: 27, scope: "weekly" },
    { label: "Fable", remainingPercent: 0, scope: "model" },
  ]);
});

test("parses the current Claude /usage response shape", () => {
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    result: [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 57% used · resets Sep 1 at 6:29pm (Asia/Taipei)",
      "Current week (all models): 44% used · resets Sep 3 at 7:59pm (Asia/Taipei)",
    ].join("\n"),
  });

  assert.deepEqual(parseClaudeUsage(raw).map(({ label, remainingPercent }) => ({ label, remainingPercent })), [
    { label: "本次時段", remainingPercent: 43 },
    { label: "本週", remainingPercent: 56 },
  ]);
});

test("normalizes Codex primary and secondary rate-limit windows", () => {
  const windows = normalizeCodexUsage({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 15, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 70, resetsAt: 1_800_086_400, windowDurationMins: 10_080 },
    },
  });

  assert.deepEqual(windows.map(({ label, remainingPercent }) => ({ label, remainingPercent })), [
    { label: "5 小時", remainingPercent: 85 },
    { label: "7 天", remainingPercent: 30 },
  ]);
  assert.match(windows[0].resetsAt ?? "", /^2027-/);
});

test("ignores malformed reset timestamps without crashing", () => {
  const [window] = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 42, resetsAt: "not-a-date" } } });
  assert.equal(window.remainingPercent, 58);
  assert.equal(window.resetsAt, null);
  assert.deepEqual(parseClaudeUsage("not usage output"), []);
});

test("does not spawn the provider CLI for a provider that has not started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-usage-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new ProviderUsageRegistry(store, () => undefined, () => "unauthenticated");

    // A forced refresh on a not-ready provider must resolve to a neutral,
    // non-loading, error-free state without ever reading live usage.
    const state = await registry.refresh("claude", true);
    assert.equal(state.loading, false);
    assert.equal(state.error, null);
    assert.equal(state.source, "empty");
    assert.equal(state.updatedAt, null);
    assert.deepEqual(state.windows, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads Codex and leaves unavailable Claude subscription usage unqueried", async () => {
  const accounts = [
    { id: "claude-work", provider: "claude" as const, label: "work", homeDir: "/accounts/claude-work", createdAt: "", updatedAt: "" },
    { id: "codex-personal", provider: "codex" as const, label: "personal", homeDir: "/accounts/codex-personal", createdAt: "", updatedAt: "" },
  ];
  const reads: Array<[string, string]> = [];
  const registry = new AccountUsageRegistry(
    () => accounts,
    () => "authenticated",
    () => undefined,
    async (provider, homeDir) => {
      reads.push([provider, homeDir]);
      return [{ id: homeDir, label: "5 小時", usedPercent: 25, remainingPercent: 75, resetsAt: null, scope: "rate" }];
    },
  );

  const states = await registry.refreshAll(true);
  assert.deepEqual(reads, [["codex", "/accounts/codex-personal"]]);
  assert.equal(states["claude-work"]?.provider, "claude");
  assert.equal(states["codex-personal"]?.provider, "codex");
  assert.match(states["claude-work"]?.error ?? "", /等待既有 Claude 工作階段/);
  registry.report("claude-work", parseClaudeUsage("Current session: 57% used · resets Sep 1 at 6:29pm (Asia/Taipei)"));
  assert.equal(registry.getStates()["claude-work"]?.windows[0]?.remainingPercent, 43);
});

test("does not query usage for a named account that is not signed in", async () => {
  const account = { id: "signed-out", provider: "codex" as const, label: "signed out", homeDir: "/accounts/signed-out", createdAt: "", updatedAt: "" };
  const registry = new AccountUsageRegistry(
    () => [account],
    () => "unauthenticated",
    () => undefined,
    async () => { throw new Error("the CLI must not run"); },
  );

  const state = await registry.refresh(account.id, true);
  assert.equal(state.source, "empty");
  assert.deepEqual(state.windows, []);
});

// idleState() (constructor-time load from disk) always recomputes source as
// "cache"/"empty" itself — it never trusts a stored "live" label. So to test
// the in-memory relabeling that happens when a provider signs out *during*
// the same process lifetime (the actual bug: a live fetch succeeds, then the
// provider becomes unauthenticated without a restart), the "live" state has
// to be seeded directly on the instance, the same way codexCapabilities.test.ts
// seeds `(registry as any).state` — there's no injectable CLI executor here to
// fake a real refresh() call into producing it.
function seedLiveState(registry: ProviderUsageRegistry, provider: "codex" | "claude") {
  (registry as any).states = {
    ...(registry as any).states,
    [provider]: {
      provider, windows: [{ id: "w", label: "5 小時", usedPercent: 10, remainingPercent: 90, resetsAt: null, scope: "rate" }],
      loading: false, source: "live", updatedAt: new Date().toISOString(), error: null,
    },
  };
}

test("a provider still 'checking' keeps its previously shown windows untouched (no flicker while the 3s re-poll settles)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-usage-checking-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new ProviderUsageRegistry(store, () => undefined, () => "checking");
    seedLiveState(registry, "codex");

    const state = await registry.refresh("codex", true);
    assert.equal(state.source, "live");
    assert.equal(state.windows.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmed sign-out relabels stale 'live' windows as 'cache' instead of showing them as current", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pixel-crew-usage-signedout-"));
  const store = new LocalStore(join(dir, "test.sqlite"));
  try {
    const registry = new ProviderUsageRegistry(store, () => undefined, () => "unauthenticated");
    seedLiveState(registry, "codex");

    const state = await registry.refresh("codex", true);
    assert.equal(state.source, "cache");
    // The windows themselves are kept (still useful context), just no longer
    // presented as "current" — this mirrors the existing 快取 badge, not a new UI concept.
    assert.equal(state.windows.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
