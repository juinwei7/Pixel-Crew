import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnergyHud, FocusEnergy } from "../src/components/EnergyHud";
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
  const html = renderToStaticMarkup(<EnergyHud usage={{ claude: state("claude", 27), codex: state("codex", 64) }} onRefresh={async () => null} totalCostUsd={12.34} />);
  assert.match(html, /WORK ENERGY/);
  assert.match(html, /CLAUDE/);
  assert.match(html, /CODEX/);
  assert.match(html, /27%/);
  assert.match(html, /64%/);
  assert.match(html, /US\$\s*12\.34/);
  assert.doesNotMatch(html, /房間/);
});

test("renders zero total cost as US$ 0.00 rather than blank or NaN", () => {
  const html = renderToStaticMarkup(<EnergyHud usage={{ claude: state("claude", 27), codex: state("codex", 64) }} onRefresh={async () => null} totalCostUsd={0} />);
  assert.match(html, /US\$\s*0\.00/);
});

test("focus energy keeps both providers and reset context visible", () => {
  const html = renderToStaticMarkup(<FocusEnergy usage={{ claude: state("claude", 27), codex: state("codex", 64) }} onRefresh={async () => null} totalCostUsd={12.34} open={false} onOpenChange={() => {}} />);
  assert.match(html, /查看專心模式工作用量/);
  assert.match(html, /用量與重置時間/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /27%/);
  assert.match(html, /64%/);
  assert.match(html, /US\$\s*12\.34/);
  assert.match(html, /不隨 NPC 切換/);
});

test("focus energy emphasizes only the active provider and shows its concrete model", () => {
  const html = renderToStaticMarkup(<FocusEnergy usage={{ claude: state("claude", 72), codex: state("codex", 9) }} activeProvider="codex" activeSubject={{ name: "六號機", provider: "codex", model: "gpt-5.6-terra" }} onRefresh={async () => null} totalCostUsd={0} open={false} onOpenChange={() => {}} />);
  assert.match(html, /focus-energy__summary--low/);
  assert.match(html, /用量偏低/);
  assert.match(html, /9%/);
  assert.match(html, /FOCUS SUBJECT/);
  assert.match(html, /六號機/);
  assert.match(html, /Codex · gpt-5\.6-terra/);
});
