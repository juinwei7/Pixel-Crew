import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeCodexUsage, parseClaudeUsage, ProviderUsageRegistry } from "../src/providerUsage.js";
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
    const registry = new ProviderUsageRegistry(store, () => undefined, () => false);

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
