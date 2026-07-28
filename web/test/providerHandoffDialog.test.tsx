import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderHandoffDialog } from "../src/components/ProviderHandoffDialog";
import { emptyWorker } from "../src/workerState";

test("renders an explicit cross-LLM handoff progress and local fallback warning", () => {
  const worker = emptyWorker("one", "一號機", null, true, 0, "claude", "/repo");
  worker.handoff = {
    id: "handoff-1",
    fromProvider: "claude",
    toProvider: "codex",
    toModel: null,
    stage: "bootstrapping",
    message: "Codex 正在讀取交接資料",
    source: "local_fallback",
    error: null,
  };
  const html = renderToStaticMarkup(
    <ProviderHandoffDialog worker={worker} toProvider="codex" onPrepare={async () => ({ error: "unused" })} onStart={async () => null} onDirectSwitch={async () => null} onClose={() => undefined} />,
  );
  assert.match(html, /SHIFT CHANGE/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /本機任務紀錄交接/);
  assert.match(html, /新 LLM 讀取交接/);
});

test("ignores a terminal handoff from before the dialog opened so the user can retry", () => {
  const worker = emptyWorker("one", "一號機", null, false, 0, "claude", "/repo");
  worker.handoff = {
    id: "old-failure",
    fromProvider: "claude",
    toProvider: "codex",
    toModel: null,
    stage: "failed",
    message: "交接失敗",
    source: "agent",
    error: "old error",
  };
  const html = renderToStaticMarkup(
    <ProviderHandoffDialog worker={worker} toProvider="codex" onPrepare={async () => ({ error: "unused" })} onStart={async () => null} onDirectSwitch={async () => null} onClose={() => undefined} />,
  );
  assert.match(html, /正在確認登入狀態與即時工作能量/);
  assert.match(html, /不交接，直接切換/);
  assert.doesNotMatch(html, /old error/);
});
