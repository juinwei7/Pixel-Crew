// 前後端共用的「跨線協定」型別唯一權威來源。
// server 端各模組 import 這裡再 re-export 維持舊路徑；web/src/types.ts 以
// type-only re-export 引用（Vite 編譯時擦除，零 runtime 依賴）。
// 這個檔案必須保持零 import——兩邊 tsconfig 都要能無痛納入。

export type McpScope = "local" | "project" | "user" | "account";
export type McpTransport = "stdio" | "sse" | "http";

export type McpToolInfo = {
  name: string;
  description?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

export type McpServerState = {
  name: string;
  status: string;
  scope?: McpScope;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  // Only the names of env vars / headers are ever kept — the values (which
  // `claude mcp get` prints in plaintext, e.g. bearer tokens) are dropped
  // during parsing and never reach the API response or the frontend.
  envKeys?: string[];
  headerNames?: string[];
  detail?: string;
  // Codex only — the frontend gates login/logout on this rather than `status`,
  // since Codex's status is enabled/disabled (is the server on?), not auth
  // state. See codexCapabilities.ts's parseCodexMcpList.
  authStatus?: string;
  // Full tool catalog, when the provider's CLI can supply one. Currently
  // Codex-only, via the experimental mcpServerStatus/list app-server method.
  tools?: McpToolInfo[];
  // "available": `tools` is a complete, live catalog (Codex, once fetched).
  // "unsupported": no API exists to list tools proactively — Claude, always.
  // "error": Codex's call failed/unavailable this time (older CLI, method
  // renamed/removed, no active worker yet). undefined: not checked yet.
  toolsStatus?: "available" | "unsupported" | "error";
  // Codex's own internal codex_apps server — real and connected, but not
  // user-configured/removable the way `codex mcp add`'d servers are.
  builtin?: boolean;
};

export type ModelOption = { id: string; label: string; description?: string };

export type CapabilityState = {
  slashCommands: string[];
  mcpServers: McpServerState[];
  models: ModelOption[];
  toolCount: number | null;
  // Built-in tools available in the most recent Claude session at init time
  // (Bash, Read, Edit, …). NOT an MCP server's tool list — see the RunnerEvent
  // "meta" comment below. null = never observed yet, distinct from an empty
  // array (observed and genuinely empty).
  builtinTools: string[] | null;
  loading: boolean;
  source: "empty" | "cache" | "live";
  updatedAt: string | null;
  error: string | null;
};

// "off": always prompts. "safe": narrow allowlist (read-only tools + a
// curated set of verified-safe commands) — still asks for anything else.
// "full": allows everything except commands matched by the dangerous-command
// denylist (rm -rf, sudo, git push --force, …).
// "invincible": 無限制——完全不設限、永不詢問（連 rm -rf / sudo 都放行），風險自負。
export type AutoApproveMode = "off" | "safe" | "full" | "invincible";

export type ApprovalDecision = "allow_once" | "allow_session" | "deny" | "auto_allow";

export type ApprovalRequest = {
  id: string;
  activityId: string | null;
  category: "command" | "file_change" | "tool" | "permissions";
  title: string;
  input: unknown;
  command?: string;
  cwd?: string;
  reason?: string;
  decisions: ApprovalDecision[];
  // 白話審批卡用：原始工具名（title 只有句子），以及指令命中危險清單時的中文風險描述。
  toolName?: string;
  riskReason?: string;
};

// at＝server 記錄事件當下的 epoch ms（record() 統一蓋章）。事件會持久化＋重播，
// 前端顯示「事件發生時間」一律用它，別用瀏覽器收到的時間（重整重播會全變成現在）。
export type RunnerEvent =
  | { type: "text_delta"; text: string; at?: number }
  | { type: "thinking_delta"; text: string; at?: number }
  | { type: "tool_call_start"; id: string; name: string; input: unknown; at?: number }
  | { type: "tool_call_output_delta"; id: string; delta: string; at?: number }
  | { type: "tool_call_result"; id: string; output: unknown; isError: boolean; at?: number }
  | { type: "approval_requested"; request: ApprovalRequest; at?: number }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision; at?: number }
  | {
      type: "turn_end";
      at?: number;
      resultText: string;
      costUsd: number;
      durationMs: number;
      isError: boolean;
      permissionDenials: unknown[];
      // 這回合最後一次 API 請求的總 token（input+cache+output）≈ 目前 session 的
      // context 佔用量，前端拿來畫「距離自動 compact 還有多遠」的量條。Codex 沒給。
      contextTokens?: number;
    }
  | {
      type: "meta";
      at?: number;
      model: string;
      slashCommands: string[];
      // 線上實際只送 name+status（見 claudeRunner 組裝處）；不要在這裡標成完整
      // McpServerState——前端曾因手抄漂移誤以為 meta 帶完整欄位。
      mcpServers: Array<{ name: string; status: string }>;
      toolCount: number;
      // Built-in tools (Bash, Read, Edit, …) available at session init time —
      // NOT an MCP server's tool list. The init frame fires before slow MCP
      // servers finish connecting, so it typically excludes their tools.
      builtinTools: string[];
    }
  | { type: "user_message"; text: string; departmentFollowUpMissionId?: string; at?: number }
  | { type: "error"; message: string; at?: number };
