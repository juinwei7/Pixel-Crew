// gate-2b-lite · 隔離沙盒單一決策回合實跑（真打 API、不上網）。
// 目的：2a 證了「叫它查、它真查得到」；這裡證「決策模型在完整 prompt 下，遇到明顯需要現時
// 資訊、手上沒有的情況，會主動選 action:explore 並給出合理查詢」。純決策回合、不用工具。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSession } from "../src/claudeRunner.js";
import { config } from "../src/config.js";
import {
  workerAutopilotNextPrompt,
  parseWorkerAutopilotDecision,
  normalizeWorkerAutopilotPlan,
} from "../src/workerAutopilot.js";
import type { RunnerEvent } from "../src/protocol.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gate2b-"));

// 情境：目標需要「現在最新版本」這個即時事實，NPC 上一回合明說手上沒有、無法決定——
// 這正是該 explore 的場景。計畫的 blockers 也點明卡在這個不知道的事實上。
const plan = normalizeWorkerAutopilotPlan({
  goal: "把專案的 zod 依賴升級到最新穩定版並確認相容",
  hypotheses: ["目前鎖的版本可能過舊"],
  tried: [{ text: "讀 package.json 看目前鎖的是 zod ^3.22", outcome: "確認目前是 3.22，但不知道現在最新是幾" }],
  toTry: [{ text: "查出 zod 現在最新穩定版版本號", need: "上網" }],
  blockers: ["不知道 zod 現在最新穩定版是幾號，無法決定升級跨幾個大版本"],
});
const prompt = workerAutopilotNextPrompt({
  workerName: "依賴升級手",
  role: "前端工程",
  workspaceLabel: workspace,
  turns: [{
    instruction: "開始規劃把 zod 升級到最新穩定版",
    result: "我讀了 package.json，目前鎖的是 zod ^3.22。但要定升級策略，我必須先知道「現在最新穩定版是幾號」——這是即時資訊，我手上沒有、也不該憑記憶猜（記憶可能過期）。在知道確切最新版本前，我無法判斷要跨幾個大版本、有沒有 breaking change。",
  }],
  stepsRemaining: 4,
  proactive: true,
  originalGoal: "把專案的 zod 依賴升級到最新穩定版並確認相容",
  plan,
  canExplore: true,
});

let streamed = "";

async function run(): Promise<void> {
  console.log("=== gate-2b-lite 決策回合實跑 ===");
  console.log("workspace(隔離):", workspace);
  console.log("情境: 目標需要 zod 最新版本號（即時資訊），NPC 已明說手上沒有、不該憑記憶");
  console.log("canExplore: true（預算內）");
  console.log("------ 等待決策 ------");

  const result = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("逾時 180s")); } }, 180_000);
    const finish = (err?: Error, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session.stop(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(text);
    };
    const session = new ClaudeSession(
      (event: RunnerEvent) => {
        if (event.type === "text_delta") { streamed += event.text; return; }
        if (event.type === "tool_call_start") console.log(`[非預期 tool_call] ${event.name}`);
        else if (event.type === "error") console.log(`[error] ${event.message}`);
        else if (event.type === "turn_end") {
          if (event.isError) finish(new Error(event.resultText || "turn error"));
          else finish(undefined, (event.resultText || streamed).trim());
        }
      },
      workspace,
      () => [],
      () => "",
      () => "off",
      undefined,
      () => config.defaultClaudeHome,
    );
    try {
      session.send(prompt, [], []); // normal profile；prompt 本身要求不要用工具
    } catch (error) {
      finish(error as Error);
    }
  });

  console.log("------ 原始回覆尾段 ------");
  console.log(result.slice(-600));
  const decision = parseWorkerAutopilotDecision(result);
  console.log("------ 解析後 decision ------");
  console.log(JSON.stringify(decision, null, 2));
  console.log("=== gate-2b-lite 判定 ===");
  const choseExplore = decision?.action === "explore";
  const hasQuery = choseExplore && typeof (decision as { query: string }).query === "string" && (decision as { query: string }).query.length > 0;
  console.log("選了 explore:", choseExplore ? "PASS ✅" : `FAIL ❌（實得 ${decision?.action ?? "null"}）`);
  console.log("帶了具體查詢:", hasQuery ? "PASS ✅" : "FAIL ❌");
  if (!choseExplore) process.exitCode = 1;
}

run()
  .catch((e) => { console.error("gate-2b-lite 失敗:", (e as Error).message); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ } });
