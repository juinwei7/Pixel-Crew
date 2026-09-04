import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnergyHud, FocusEnergy } from "../src/components/EnergyHud";
import type { AccountWithAuth, ProviderUsageState } from "../src/types";

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
  assert.match(html, /查看專業模式工作用量/);
  assert.match(html, /關閉工作用量詳情/);
  assert.match(html, /用量與重置時間/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /27%/);
  assert.match(html, /64%/);
  assert.match(html, /US\$\s*12\.34/);
  assert.match(html, /依剩餘量由低到高排序/);
});

function account(id: string, provider: "claude" | "codex", label: string): AccountWithAuth {
  return {
    id, provider, label, homeDir: `/home/${id}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    auth: { provider, displayName: label, status: "authenticated", loginCommand: "", checkedAt: null, error: null, debug: null },
  };
}

test("shared login and a named account render as the same kind of row, grouped under one provider heading", () => {
  const html = renderToStaticMarkup(<EnergyHud
    usage={{ claude: state("claude", 90), codex: state("codex", 90) }}
    accountUsage={{ juinwei7: state("codex", 23) }}
    accounts={[account("juinwei7", "codex", "juinwei7")]}
    onRefresh={async () => null}
    totalCostUsd={0}
  />);
  // The button is collapsed by default; open the detail panel by rendering
  // EnergyHud's sibling that always renders its body regardless of `open`.
  const detailHtml = renderToStaticMarkup(<FocusEnergy
    usage={{ claude: state("claude", 90), codex: state("codex", 90) }}
    accountUsage={{ juinwei7: state("codex", 23) }}
    accounts={[account("juinwei7", "codex", "juinwei7")]}
    onRefresh={async () => null}
    totalCostUsd={0}
    open={false}
    onOpenChange={() => {}}
  />);
  assert.match(html, /WORK ENERGY/);
  assert.match(detailHtml, /共用登入/);
  assert.match(detailHtml, /juinwei7/);
  assert.match(detailHtml, /2 個帳號/);
  // The lowest remaining window across everything (23%, juinwei7) must be
  // the first glance chip — it appears before the 90% shared-login windows.
  const glanceIndex = detailHtml.indexOf("energy-glance");
  const juinweiIndex = detailHtml.indexOf("juinwei7", glanceIndex);
  const claudeSharedIndex = detailHtml.indexOf("energy-provider__label");
  assert.ok(glanceIndex >= 0 && juinweiIndex >= 0 && juinweiIndex < claudeSharedIndex, "worst account should surface in the glance strip before the provider sections");
});

test("account warning and glance include model-specific Claude limits", () => {
  const claude = state("claude", 90);
  claude.windows.push({
    id: "claude-model",
    label: "Opus",
    usedPercent: 99,
    remainingPercent: 1,
    resetsAt: "Sep 5 at 8pm (Asia/Taipei)",
    scope: "model",
  });
  const html = renderToStaticMarkup(<FocusEnergy
    usage={{ claude, codex: state("codex", 70) }}
    onRefresh={async () => null}
    totalCostUsd={0}
    open
    onOpenChange={() => {}}
  />);
  assert.match(html, /energy-glance__chip--low[^>]*><i[^>]*><\/i>Claude<strong>1%<\/strong>/);
  assert.match(html, /energy-account__rail--low/);
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
