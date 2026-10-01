// gate-2 · 多輪「自我進化」實跑（真打 API、真上網、NPC 真做事）。
// 不是驗管路，是驗「會不會越跑越聰明」：連跑數輪完整迴圈——決策→（需要就真探索）→NPC 真做事→
// 結果與發現回灌計畫→retro 累積——最後印逐輪對照，看計畫是否實質加深、後輪是否建立在前輪之上、
// 教訓是否被帶進下一輪。隔離：temp dataDir 存計畫/retro、temp workspace 做事；認證用 app 真 claude-home。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSession } from "../src/claudeRunner.js";
import { config } from "../src/config.js";
import type { RunnerEvent } from "../src/protocol.js";
import type { AutoApproveMode } from "../src/protocol.js";
import type { SendOptions } from "../src/providers/session.js";
import {
  workerAutopilotNextPrompt,
  parseWorkerAutopilotDecision,
  workerAutopilotExplorePrompt,
  parseExplorationFindings,
  workerAutopilotResultSummary,
  seedWorkerAutopilotPlan,
  mergeWorkerAutopilotPlan,
  appendWorkerAutopilotRetro,
  isWorkerAutopilotPlanEmpty,
  WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP,
  WorkerAutopilotPlanStore,
  WorkerAutopilotRetroStore,
  type WorkerAutopilotPlan,
  type WorkerAutopilotFinding,
  type WorkerAutopilotRetro,
  type WorkerAutopilotTurn,
} from "../src/workerAutopilot.js";

const ROUNDS = 3;
const WORKER_ID = "gate2-eyo";
const WORKER_NAME = "升級研究員";
const GOAL = "在 workspace 建一份 UPGRADE-NOTES.md：研究把 zod 從 3.22 升到目前最新穩定版要注意什麼（實際版本號、主要 breaking changes、對本專案的影響）。每一輪都要讓這份筆記更完整、更有依據，而不是重寫。";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-data-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-ws-"));
const planStore = new WorkerAutopilotPlanStore(dataDir);
const retroStore = new WorkerAutopilotRetroStore(dataDir);
const plansMap: Record<string, WorkerAutopilotPlan> = {};
const retrosMap: Record<string, WorkerAutopilotRetro[]> = {};

// 單一回合執行（包 ClaudeSession，比照 runDetachedTurn 的 promise 收尾）。
function runTurn(prompt: string, opts: { autoApprove: AutoApproveMode; send?: SendOptions; timeoutMs?: number }): Promise<{ text: string; tools: string[] }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let streamed = "";
    const tools: string[] = [];
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("逾時")); } }, opts.timeoutMs ?? 240_000);
    const finish = (err?: Error, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session.stop(); } catch { /* ignore */ }
      if (err) reject(err); else resolve({ text, tools });
    };
    const session = new ClaudeSession(
      (event: RunnerEvent) => {
        if (event.type === "text_delta") streamed += event.text;
        else if (event.type === "tool_call_start") { tools.push(event.name); process.stdout.write(`  ·${event.name}`); }
        else if (event.type === "error") console.log(`\n  [error] ${event.message}`);
        else if (event.type === "turn_end") {
          if (event.isError) finish(new Error(event.resultText || "turn error"));
          else finish(undefined, (event.resultText || streamed).trim());
        }
      },
      workspace,
      () => [],
      () => "",
      () => opts.autoApprove,
      undefined,
      () => config.defaultClaudeHome,
    );
    try { session.send(prompt, [], [], opts.send); }
    catch (error) { finish(error as Error); }
  });
}

function planSize(p: WorkerAutopilotPlan): string {
  return `假設${p.hypotheses.length} 已試${p.tried.length} 待試${p.toTry.length} 卡點${p.blockers.length}`;
}

async function run(): Promise<void> {
  console.log("=== gate-2 多輪自我進化實跑 ===");
  console.log("dataDir(隔離):", dataDir);
  console.log("workspace(隔離):", workspace);
  console.log("目標:", GOAL);
  const turns: WorkerAutopilotTurn[] = [];
  const planGrowth: string[] = [];
  const findingsEver: WorkerAutopilotFinding[] = [];

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n================ 第 ${round} 輪 ================`);
    // 計畫：載入／種入
    let plan = plansMap[WORKER_ID];
    if (!plan || isWorkerAutopilotPlanEmpty(plan)) {
      plan = seedWorkerAutopilotPlan(GOAL, (retrosMap[WORKER_ID] ?? []).map((e) => e.note).reverse());
    }

    // 兩段式決策（含探索子迴圈）
    const findingsThisStep: WorkerAutopilotFinding[] = [];
    let exploreRounds = 0;
    let decision = null as ReturnType<typeof parseWorkerAutopilotDecision>;
    for (;;) {
      const canExplore = exploreRounds < WORKER_AUTOPILOT_MAX_EXPLORE_PER_STEP;
      const prompt = workerAutopilotNextPrompt({
        workerName: WORKER_NAME, role: "前端工程", workspaceLabel: workspace,
        turns, stepsRemaining: ROUNDS - round, proactive: true, originalGoal: GOAL,
        retros: (retrosMap[WORKER_ID] ?? []).map((e) => e.note).reverse(),
        plan, canExplore, explorationFindings: findingsThisStep,
      });
      process.stdout.write(`  [決策回合${exploreRounds ? ` 探索後${exploreRounds}` : ""}]`);
      const { text } = await runTurn(prompt, { autoApprove: "off" });
      decision = parseWorkerAutopilotDecision(text);
      console.log(`\n  → action=${decision?.action}`);
      if (decision?.planUpdate !== undefined) {
        plan = mergeWorkerAutopilotPlan(plan, decision.planUpdate, plan.updatedRound + 1).plan;
        plansMap[WORKER_ID] = plan; planStore.save(plansMap);
      }
      if (!decision || decision.action !== "explore") break;
      exploreRounds += 1;
      console.log(`  🔎 查證：${decision.query}`);
      process.stdout.write("  [探索回合]");
      try {
        const { text: expText } = await runTurn(
          workerAutopilotExplorePrompt({ workerName: WORKER_NAME, workspaceLabel: workspace, query: decision.query, originalGoal: GOAL }),
          { autoApprove: "off", send: { executionProfile: "read_only_query", queryAllowedTools: [], queryAllowSafeShell: true } },
        );
        const finding = parseExplorationFindings(expText, decision.query);
        findingsThisStep.push(finding); findingsEver.push(finding);
        console.log(`\n  ← finding(${finding.confidence}): ${finding.summary.slice(0, 120)} [出處${finding.sources.length}]`);
      } catch (e) {
        console.log(`\n  ← 探索失敗：${(e as Error).message}`);
        findingsThisStep.push({ query: decision.query, summary: "(查不到)", confidence: "low", sources: [] });
      }
    }

    planGrowth.push(`第${round}輪結束：${planSize(plan)}`);
    if (!decision || decision.action === "stop") {
      if (decision?.action === "stop" && decision.retro) { appendWorkerAutopilotRetro(retrosMap, WORKER_ID, decision.retro, Date.now()); retroStore.save(retrosMap); }
      console.log(`  🅿️ 決策 STOP：${decision?.action === "stop" ? decision.reason : "無有效指示"}`);
      break;
    }

    // NPC 真做事（full 自動核准：temp 沙盒內可寫檔；通道 E 仍擋工作區外寫入；危險 Bash 仍擋）
    console.log(`  📋 指示：${decision.instruction.slice(0, 160)}…`);
    process.stdout.write("  [NPC 工作回合]");
    const { text: workText, tools } = await runTurn(decision.instruction, { autoApprove: "full" });
    console.log(`\n  ✓ NPC 完成（用到工具：${[...new Set(tools)].join(",") || "無"}）`);
    turns.push({ instruction: decision.instruction, result: workerAutopilotResultSummary(workText) });
    if (decision.retro) { appendWorkerAutopilotRetro(retrosMap, WORKER_ID, decision.retro, Date.now()); retroStore.save(retrosMap); }
  }

  // ── 進化對照 ──
  console.log("\n================ 自我進化對照 ================");
  console.log("逐輪計畫規模：");
  planGrowth.forEach((g) => console.log("  " + g));
  const finalPlan = plansMap[WORKER_ID];
  console.log("\n最終計畫：");
  console.log("  goal:", finalPlan?.goal?.slice(0, 80));
  console.log("  hypotheses:", JSON.stringify(finalPlan?.hypotheses));
  console.log("  tried:", JSON.stringify(finalPlan?.tried.map((t) => t.text)));
  console.log("  blockers:", JSON.stringify(finalPlan?.blockers));
  console.log("\n累積 retro 教訓（跨輪帶入下一輪）：", JSON.stringify((retrosMap[WORKER_ID] ?? []).map((r) => r.note)));
  console.log("探索真實發現次數：", findingsEver.length, "｜有出處的：", findingsEver.filter((f) => f.sources.length).length);
  const files = fs.existsSync(workspace) ? fs.readdirSync(workspace) : [];
  console.log("workspace 產出檔案：", JSON.stringify(files));
  const notes = files.find((f) => /upgrade/i.test(f));
  if (notes) {
    const content = fs.readFileSync(path.join(workspace, notes), "utf8");
    console.log(`\n--- ${notes}（${content.length} 字，尾段）---`);
    console.log(content.slice(-700));
  }
  console.log("\n=== 判定要點 ===");
  console.log("計畫是否逐輪成長：看上面三行規模是否遞增");
  console.log("是否用真實資訊：探索發現", findingsEver.length, "筆");
  console.log("是否累積教訓：retro", (retrosMap[WORKER_ID] ?? []).length, "條");
}

run()
  .catch((e) => { console.error("\ngate-2 失敗:", (e as Error).message); process.exitCode = 1; })
  .finally(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
