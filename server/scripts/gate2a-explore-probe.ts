// gate-2a · 隔離沙盒單一探索回合實跑（真打 API／真上網）。
// 目的：證明支柱 B 最不確定的一塊——唯讀查詢回合（read_only_query + allowSafeShell）裡，
// WebSearch 真的上得了網、分類器沒擋錯、結構化 finding 回得來。隔離：丟棄式 temp workspace，
// 認證用 app 已登入的 claude-home，不碰正式 app 的資料。跑完清掉 workspace。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSession } from "../src/claudeRunner.js";
import { config } from "../src/config.js";
import { workerAutopilotExplorePrompt, parseExplorationFindings } from "../src/workerAutopilot.js";
import type { RunnerEvent } from "../src/protocol.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gate2a-"));
const query = "npm 套件 zod 目前最新的穩定發行版本號是多少？請實際去查（npm registry 或官方來源），不要憑記憶。";
const prompt = workerAutopilotExplorePrompt({
  workerName: "探路測試",
  workspaceLabel: workspace,
  query,
  originalGoal: "gate-2a 驗證探索真的會上網查到真相",
});

const toolCalls: Array<{ name: string; isError: boolean | null }> = [];
let streamed = "";

async function run(): Promise<void> {
  console.log("=== gate-2a 探索實跑 ===");
  console.log("workspace(隔離):", workspace);
  console.log("claude-home(認證):", config.defaultClaudeHome);
  console.log("查詢:", query);
  console.log("------ 事件串流 ------");

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
        if (event.type === "tool_call_start") {
          toolCalls.push({ name: event.name, isError: null });
          const input = (() => { try { return JSON.stringify(event.input).slice(0, 160); } catch { return ""; } })();
          console.log(`[tool_call] ${event.name} ${input}`);
        } else if (event.type === "tool_call_result") {
          const last = toolCalls.find((c) => c.isError === null);
          if (last) last.isError = event.isError;
          console.log(`[tool_result] isError=${event.isError}`);
        } else if (event.type === "approval_requested") {
          console.log(`[approval] ${event.request.title}${event.request.reason ? " — " + event.request.reason : ""}`);
        } else if (event.type === "approval_resolved") {
          console.log(`[approval_resolved] ${event.decision}`);
        } else if (event.type === "error") {
          console.log(`[error] ${event.message}`);
        } else if (event.type === "turn_end") {
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
      session.send(prompt, [], [], { executionProfile: "read_only_query", queryAllowedTools: [], queryAllowSafeShell: true });
    } catch (error) {
      finish(error as Error);
    }
  });

  console.log("------ 回合結束 ------");
  console.log("工具呼叫:", toolCalls.map((c) => c.name).join(", ") || "(無)");
  const webUsed = toolCalls.some((c) => c.name === "WebSearch" || c.name === "WebFetch");
  console.log("有真的上網(WebSearch/WebFetch)?", webUsed ? "是 ✅" : "否 ❌");
  console.log("------ 原始回覆尾段 ------");
  console.log(result.slice(-800));
  const finding = parseExplorationFindings(result, query);
  console.log("------ 解析後 finding ------");
  console.log(JSON.stringify(finding, null, 2));
  console.log("=== gate-2a 判定 ===");
  console.log("上網:", webUsed ? "PASS" : "FAIL", "| 有結構化摘要:", finding.summary ? "PASS" : "FAIL",
    "| 信心:", finding.confidence, "| 出處數:", finding.sources.length);
}

run()
  .catch((e) => { console.error("gate-2a 失敗:", (e as Error).message); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ } });
