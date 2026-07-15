import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnergyHud } from "../src/components/EnergyHud";
import type { ProviderUsageState } from "../src/types";

function state(provider: "claude" | "codex", remaining: number): ProviderUsageState {
  return {
    provider,
    windows: [{ id: `${provider}-weekly`, label: "本週", usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: null, scope: "weekly" }],
    loading: false,
    source: "live",
    updatedAt: "2026-07-16T00:00:00.000Z",
    error: null,
  };
}

test("renders account-wide Claude and Codex work energy in one HUD", () => {
  const html = renderToStaticMarkup(<EnergyHud usage={{ claude: state("claude", 27), codex: state("codex", 64) }} onRefresh={async () => null} />);
  assert.match(html, /WORK ENERGY/);
  assert.match(html, /CLAUDE/);
  assert.match(html, /CODEX/);
  assert.match(html, /27%/);
  assert.match(html, /64%/);
  assert.doesNotMatch(html, /房間/);
});
