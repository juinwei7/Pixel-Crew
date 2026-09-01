import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountLoginState, AccountWithAuth, ApprovalDecision, AutoApproveMode, BossAssignmentResponse, BossTask, CapabilityState, ClaudeLoginState, CodexAccountLoginMode, CollaborationMode, CollaborationTask, CommandSubmission, Department, DepartmentMission, DepartmentThreadPayload, HandoffProgress, McpLoginResult, Persona, PreparedCollaboration, PreparedHandoff, PreparedMission, ProviderAuthState, ProviderId, ProviderInstallState, ProviderUsageState, RunnerEvent, UpdateInfo, WorkerState } from "../types";
import { applyRunnerEvent, emptyWorker } from "../workerState";
import { apiRequest } from "../api";
import { t } from "../i18n";

const browserWsOrigin = typeof window !== "undefined"
  ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
  : "ws://localhost:8787";
const WS_URL = import.meta.env.VITE_WS_URL?.trim() || browserWsOrigin;

type SystemStatus = {
  platform: string;
  arch: string;
  release: string;
  node: string;
  dataDirectory: string;
  folderPicker: boolean;
  workspaceSetupRequired: boolean;
  codexWindowsBestEffort: boolean;
  /** Local provider settings resolved by the server; labels an NPC with no explicit model override. */
  providerDefaultModels?: Partial<Record<ProviderId, string>>;
  /** server 換腦門檻（tokens）；CTX 量條的 100% 基準。舊 server 沒帶就用 web 後備值。 */
  brainSwapThresholdTokens?: number;
};

type ServerMessage =
  | {
      type: "snapshot";
      targetRepoPath: string;
      system?: SystemStatus;
      stats?: { completedTurns: number; totalCostUsd: number };
      updateInfo?: UpdateInfo;
      workspacePaths: string[];
      auth: ProviderAuthState[];
      accounts?: AccountWithAuth[];
      providerUsage: Record<ProviderId, ProviderUsageState>;
      accountUsage?: Record<string, ProviderUsageState>;
      capabilitiesByWorkspace: Record<string, Record<ProviderId, CapabilityState>>;
      collaborations?: CollaborationTask[];
      missions?: DepartmentMission[];
      bossTasks?: BossTask[];
      departments?: Department[];
      workers: Array<{
        id: string;
        name: string;
        model: string | null;
        busy: boolean;
        colorIndex: number;
        avatarId: string | null;
        avatarKind: "preset" | "custom";
        avatarPresetId: string;
        provider: ProviderId;
        workspacePath: string;
        departmentId?: string | null;
        accountId?: string | null;
        persona: Persona | null;
        autoApproveMode: AutoApproveMode;
        handoff: HandoffProgress | null;
        resumeCandidate?: WorkerState["resumeCandidate"];
        events: RunnerEvent[];
      }>;
    }
  | { type: "event"; workerId: string; event: RunnerEvent }
  | { type: "worker_added"; worker: WorkerSummary }
  | { type: "worker_removed"; workerId: string }
  | { type: "worker_updated"; worker: WorkerSummary; reset?: boolean }
  | { type: "workers_reordered"; order: string[] }
  | { type: "worker_status"; workerId: string; busy: boolean }
  | { type: "collaboration_created" | "collaboration_updated"; collaboration: CollaborationTask }
  | { type: "mission_created" | "mission_updated"; mission: DepartmentMission }
  | { type: "boss_task_created" | "boss_task_updated"; bossTask: BossTask }
  | { type: "boss_task_deleted"; bossTaskId: string }
  | { type: "department_created" | "department_updated"; department: Department }
  | { type: "department_removed"; departmentId: string }
  | { type: "capabilities_updated"; workspacePath: string; provider: ProviderId; capabilities: CapabilityState }
  | ({ type: "mcp_login_result" } & McpLoginResult)
  | { type: "workflow_library_updated"; workspacePath: string; provider: ProviderId; revision: number }
  | { type: "auth_updated"; auth: ProviderAuthState }
  | { type: "usage_updated"; provider: ProviderId; usage: ProviderUsageState }
  | { type: "account_usage_updated"; accountId: string; usage: ProviderUsageState }
  | { type: "stats_updated"; stats: { completedTurns: number; totalCostUsd: number } }
  | { type: "update_info"; updateInfo: UpdateInfo }
  | { type: "account_login_result"; accountId: string; ok: boolean; status: AccountLoginState["status"]; message: string | null }
  | { type: "account_login_url"; accountId: string; loginUrl: string | null; status?: AccountLoginState["status"] }
  | { type: "account_auth_updated"; accountId: string; auth: ProviderAuthState }
  | { type: "codex_default_login_result"; ok: boolean; status: AccountLoginState["status"]; message: string | null }
  | { type: "codex_default_login_url"; loginUrl: string | null }
  | { type: "claude_default_login_result"; ok: boolean; status: ClaudeLoginState["status"]; message: string | null }
  | { type: "claude_default_login_url"; loginUrl: string | null; status: ClaudeLoginState["status"] };

type WorkerSummary = {
  id: string;
  name: string;
  model: string | null;
  busy: boolean;
  colorIndex: number;
  avatarId: string | null;
  avatarKind: "preset" | "custom";
  avatarPresetId: string;
  provider: ProviderId;
  workspacePath: string;
  departmentId?: string | null;
  accountId?: string | null;
  persona: Persona | null;
  autoApproveMode: AutoApproveMode;
  handoff: HandoffProgress | null;
  resumeCandidate?: WorkerState["resumeCandidate"];
};

function defaultAuth(
  provider: ProviderId,
  displayName: string,
  loginCommand: string,
): ProviderAuthState {
  return {
    provider,
    displayName,
    status: "checking",
    loginCommand,
    checkedAt: null,
    error: null,
    debug: null,
  };
}

export function useWorkers() {
  const [workers, setWorkers] = useState<Record<string, WorkerState>>({});
  const [collaborations, setCollaborations] = useState<Record<string, CollaborationTask>>({});
  const [missions, setMissions] = useState<Record<string, DepartmentMission>>({});
  const [bossTasks, setBossTasks] = useState<Record<string, BossTask>>({});
  const [departments, setDepartments] = useState<Record<string, Department>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [mcpLoginResult, setMcpLoginResult] = useState<(McpLoginResult & { seq: number }) | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [targetRepoPath, setTargetRepoPath] = useState("");
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [stats, setStats] = useState<{ completedTurns: number; totalCostUsd: number }>({
    completedTurns: 0,
    totalCostUsd: 0,
  });
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [wsReady, setWsReady] = useState(false);
  const emptyCapabilities = (): CapabilityState => ({
    slashCommands: [],
    mcpServers: [],
    models: [],
    toolCount: null,
    builtinTools: null,
    loading: true,
    source: "empty",
    updatedAt: null,
    error: null,
  });
  const [capabilitiesByWorkspace, setCapabilitiesByWorkspace] = useState<
    Record<string, Record<ProviderId, CapabilityState>>
  >({});
  const [workflowRevisions, setWorkflowRevisions] = useState<Record<string, number>>({});
  const [auth, setAuth] = useState<Record<ProviderId, ProviderAuthState>>({
    claude: defaultAuth("claude", "Claude Code", "claude auth login"),
    codex: defaultAuth("codex", "Codex", "codex login"),
  });
  const emptyUsage = (provider: ProviderId): ProviderUsageState => ({
    provider, windows: [], loading: true, source: "empty", updatedAt: null, error: null,
  });
  const [providerUsage, setProviderUsage] = useState<Record<ProviderId, ProviderUsageState>>({
    claude: emptyUsage("claude"),
    codex: emptyUsage("codex"),
  });
  const [accountUsage, setAccountUsage] = useState<Record<string, ProviderUsageState>>({});
  const emptyInstall = (provider: ProviderId): ProviderInstallState => ({
    provider, status: "idle", phase: t("尚未開始"), command: "", sourceUrl: "",
    startedAt: null, finishedAt: null, output: "", error: null,
  });
  const [providerInstalls, setProviderInstalls] = useState<Record<ProviderId, ProviderInstallState>>({
    claude: emptyInstall("claude"),
    codex: emptyInstall("codex"),
  });
  const [accounts, setAccounts] = useState<Record<string, AccountWithAuth>>({});
  const [accountLogins, setAccountLogins] = useState<Record<string, AccountLoginState>>({});
  const [defaultCodexLogin, setDefaultCodexLogin] = useState<AccountLoginState | null>(null);
  const [defaultClaudeLogin, setDefaultClaudeLogin] = useState<ClaudeLoginState | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let connectedOnce = false;
    const pendingApprovals = new Map<string, number>();

    function connect() {
      socket = new WebSocket(`${WS_URL}/ws`);
      socket.onopen = () => {
        if (connectedOnce) void apiRequest("/api/diagnostics/events", { method: "POST", body: { kind: "websocket_reconnect", value: 1 } }).catch(() => {});
        connectedOnce = true;
        setWsReady(true);
      };
      socket.onclose = () => {
        setWsReady(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      socket.onmessage = (msg) => {
        const data: ServerMessage = JSON.parse(msg.data);
        handleMessage(data);
      };
    }

    function handleMessage(data: ServerMessage) {
      switch (data.type) {
        case "snapshot": {
          setTargetRepoPath(data.targetRepoPath);
          setSystem(data.system ?? null);
          if (data.stats) setStats(data.stats);
          if (data.updateInfo) setUpdateInfo(data.updateInfo);
          setWorkspacePaths(data.workspacePaths);
          setAuth(Object.fromEntries(data.auth.map((item) => [item.provider, item])) as Record<ProviderId, ProviderAuthState>);
          setAccounts(Object.fromEntries((data.accounts ?? []).map((account) => [account.id, account])));
          setProviderUsage(data.providerUsage ?? { claude: emptyUsage("claude"), codex: emptyUsage("codex") });
          setAccountUsage(data.accountUsage ?? {});
          setCapabilitiesByWorkspace(data.capabilitiesByWorkspace ?? {});
          setCollaborations(Object.fromEntries((data.collaborations ?? []).map((task) => [task.id, task])));
          setMissions(Object.fromEntries((data.missions ?? []).map((mission) => [mission.id, mission])));
          setBossTasks(Object.fromEntries((data.bossTasks ?? []).map((task) => [task.id, task])));
          setDepartments(Object.fromEntries((data.departments ?? []).map((department) => [department.id, department])));
          const record: Record<string, WorkerState> = {};
          const ids: string[] = [];
          for (const w of data.workers) {
            let state = emptyWorker(
              w.id,
              w.name,
              w.model,
              w.busy,
              w.colorIndex ?? 0,
              w.provider,
              w.workspacePath,
              w.avatarId,
              w.persona ?? null,
              w.avatarKind,
              w.avatarPresetId,
              w.handoff ?? null,
              w.autoApproveMode ?? "off",
            );
            for (const event of w.events) state = applyRunnerEvent(state, event);
            // A persisted running turn cannot still have a live provider
            // callback after the server restarted. Close it honestly instead
            // of leaving a dead approval card clickable forever. A normal
            // browser reconnect preserves it because the worker is still busy.
            if (!w.busy && state.turns[state.turns.length - 1]?.status === "running") {
              state = applyRunnerEvent(state, {
                type: "error",
                message: t("工作階段已中止；請重新下指令"),
              });
            }
            state.busy = w.busy;
            state.departmentId = w.departmentId ?? null;
            state.accountId = w.accountId ?? null;
            state.resumeCandidate = w.resumeCandidate ?? null;
            record[w.id] = state;
            ids.push(w.id);
          }
          setWorkers(record);
          setOrder(ids);
          setActiveId((cur) => (cur && record[cur] ? cur : ids[0] ?? null));
          break;
        }
        case "event": {
          if (data.event.type === "approval_requested") pendingApprovals.set(data.event.request.id, Date.now());
          if (data.event.type === "approval_resolved") {
            const startedAt = pendingApprovals.get(data.event.id);
            if (startedAt) {
              pendingApprovals.delete(data.event.id);
              void apiRequest("/api/diagnostics/events", { method: "POST", body: { kind: "approval_wait", value: Math.round((Date.now() - startedAt) / 1_000) } }).catch(() => {});
            }
          }
          setWorkers((prev) => {
            const w = prev[data.workerId];
            if (!w) return prev;
            return { ...prev, [data.workerId]: applyRunnerEvent(w, data.event) };
          });
          break;
        }
        case "worker_added": {
          setWorkers((prev) => ({
            ...prev,
            [data.worker.id]: { ...emptyWorker(
              data.worker.id,
              data.worker.name,
              data.worker.model,
              data.worker.busy,
              data.worker.colorIndex ?? 0,
              data.worker.provider,
              data.worker.workspacePath,
              data.worker.avatarId,
              data.worker.persona,
              data.worker.avatarKind,
              data.worker.avatarPresetId,
              data.worker.handoff ?? null,
              data.worker.autoApproveMode,
            ), departmentId: data.worker.departmentId ?? null, accountId: data.worker.accountId ?? null },
          }));
          setWorkspacePaths((current) =>
            current.includes(data.worker.workspacePath)
              ? current
              : [...current, data.worker.workspacePath],
          );
          setOrder((prev) =>
            prev.includes(data.worker.id) ? prev : [...prev, data.worker.id],
          );
          break;
        }
        case "worker_removed": {
          setWorkers((prev) => {
            const next = { ...prev };
            delete next[data.workerId];
            return next;
          });
          setOrder((prev) => {
            const next = prev.filter((id) => id !== data.workerId);
            if (activeIdRef.current === data.workerId) setActiveId(next[0] ?? null);
            return next;
          });
          break;
        }
        case "workers_reordered": {
          setOrder(data.order);
          break;
        }
        case "worker_updated": {
          setWorkers((prev) => {
            const w = prev[data.worker.id];
            if (!w) return prev;
            const updatedBase = !data.reset && w.provider === data.worker.provider
              ? { ...w, ...data.worker }
              : emptyWorker(
                  data.worker.id,
                  data.worker.name,
                  data.worker.model,
                  data.worker.busy,
                  data.worker.colorIndex,
                  data.worker.provider,
                  data.worker.workspacePath,
                  data.worker.avatarId,
                  data.worker.persona,
                  data.worker.avatarKind,
                  data.worker.avatarPresetId,
                  data.worker.handoff ?? null,
                  data.worker.autoApproveMode,
                );
            const updated = { ...updatedBase, departmentId: data.worker.departmentId ?? null, accountId: data.worker.accountId ?? null };
            return { ...prev, [data.worker.id]: updated };
          });
          setWorkspacePaths((current) =>
            current.includes(data.worker.workspacePath)
              ? current
              : [...current, data.worker.workspacePath],
          );
          break;
        }
        case "worker_status": {
          setWorkers((prev) => {
            const w = prev[data.workerId];
            if (!w || w.busy === data.busy) return prev;
            return { ...prev, [data.workerId]: { ...w, busy: data.busy } };
          });
          break;
        }
        case "collaboration_created":
        case "collaboration_updated": {
          setCollaborations((current) => ({ ...current, [data.collaboration.id]: data.collaboration }));
          break;
        }
        case "mission_created":
        case "mission_updated": {
          setMissions((current) => ({ ...current, [data.mission.id]: data.mission }));
          break;
        }
        case "boss_task_created":
        case "boss_task_updated": {
          setBossTasks((current) => ({ ...current, [data.bossTask.id]: data.bossTask }));
          break;
        }
        case "boss_task_deleted": {
          setBossTasks((current) => {
            const next = { ...current };
            delete next[data.bossTaskId];
            return next;
          });
          break;
        }
        case "department_created":
        case "department_updated": {
          setDepartments((current) => ({ ...current, [data.department.id]: data.department }));
          break;
        }
        case "department_removed": {
          setDepartments((current) => {
            const next = { ...current };
            delete next[data.departmentId];
            return next;
          });
          break;
        }
        case "capabilities_updated": {
          setCapabilitiesByWorkspace((current) => ({
            ...current,
            [data.workspacePath]: {
              claude: current[data.workspacePath]?.claude ?? emptyCapabilities(),
              codex: current[data.workspacePath]?.codex ?? emptyCapabilities(),
              [data.provider]: data.capabilities,
            },
          }));
          break;
        }
        case "mcp_login_result": {
          setMcpLoginResult((prev) => ({ ...data, seq: (prev?.seq ?? 0) + 1 }));
          break;
        }
        case "workflow_library_updated": {
          setWorkflowRevisions((current) => ({
            ...current,
            [`${data.provider}\0${data.workspacePath}`]: data.revision,
          }));
          break;
        }
        case "auth_updated": {
          setAuth((current) => {
            const existing = current[data.auth.provider];
            // The background poll below re-checks every 3s while a provider
            // isn't authenticated, and the server always broadcasts a
            // transient "checking" state before the real result. Once we've
            // already shown a real status once, swallow that transient blip
            // instead of applying it — otherwise AuthGate's "checking" branch
            // (which replaces the whole login UI with a spinner) flashes in
            // and out every few seconds, looking like the page keeps
            // reloading even though this is plain WS-pushed state, not a
            // navigation. The very first check still shows "checking" since
            // the initial state (defaultAuth) starts as "checking" too.
            if (data.auth.status === "checking" && existing && existing.status !== "checking") return current;
            return { ...current, [data.auth.provider]: data.auth };
          });
          break;
        }
        case "usage_updated": {
          setProviderUsage((current) => ({ ...current, [data.provider]: data.usage }));
          break;
        }
        case "account_usage_updated": {
          setAccountUsage((current) => ({ ...current, [data.accountId]: data.usage }));
          break;
        }
        case "stats_updated": {
          setStats(data.stats);
          break;
        }
        case "update_info": {
          setUpdateInfo(data.updateInfo);
          break;
        }
        case "account_login_result": {
          setAccountLogins((current) => ({
            ...current,
            [data.accountId]: {
              accountId: data.accountId,
              status: data.status,
              startedAt: current[data.accountId]?.startedAt ?? new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              message: data.message,
              loginUrl: current[data.accountId]?.loginUrl ?? null,
            },
          }));
          break;
        }
        case "account_login_url": {
          setAccountLogins((current) => {
            const existing = current[data.accountId];
            if (!existing) return current;
            return { ...current, [data.accountId]: { ...existing, loginUrl: data.loginUrl, ...(data.status ? { status: data.status } : {}) } };
          });
          break;
        }
        case "account_auth_updated": {
          setAccounts((current) => {
            const existing = current[data.accountId];
            if (!existing) return current;
            return { ...current, [data.accountId]: { ...existing, auth: data.auth } };
          });
          break;
        }
        case "codex_default_login_result": {
          setDefaultCodexLogin((current) => ({
            accountId: "default",
            status: data.status,
            startedAt: current?.startedAt ?? new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            message: data.message,
            loginUrl: current?.loginUrl ?? null,
          }));
          break;
        }
        case "codex_default_login_url": {
          setDefaultCodexLogin((current) => (current ? { ...current, loginUrl: data.loginUrl } : current));
          break;
        }
        case "claude_default_login_result": {
          setDefaultClaudeLogin((current) => ({
            accountId: "default",
            status: data.status,
            startedAt: current?.startedAt ?? new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            message: data.message,
            loginUrl: current?.loginUrl ?? null,
          }));
          break;
        }
        case "claude_default_login_url": {
          setDefaultClaudeLogin((current) => (current ? { ...current, loginUrl: data.loginUrl, status: data.status } : current));
          break;
        }
      }
    }

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const report = (kind: "ui_long_task" | "fps_sample", value: number) => {
      void apiRequest("/api/diagnostics/events", { method: "POST", body: { kind, value } }).catch(() => {});
    };
    let observer: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        observer = new PerformanceObserver((entries) => entries.getEntries().forEach((entry) => report("ui_long_task", Math.round(entry.duration))));
        observer.observe({ type: "longtask", buffered: false });
      }
    } catch { /* diagnostics must never affect the app when the browser lacks this API */ }
    let frame = 0;
    let start = performance.now();
    let raf = 0;
    const sample = (now: number) => {
      frame += 1;
      if (now - start >= 1_000) { report("fps_sample", Math.round((frame * 1_000) / (now - start))); frame = 0; start = now; }
      raf = requestAnimationFrame(sample);
    };
    raf = requestAnimationFrame(sample);
    return () => { observer?.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const createWorker = useCallback(async (
    name?: string,
    provider: ProviderId = "claude",
    workspacePath?: string,
    model?: string,
    accountId?: string | null,
  ): Promise<{ id?: string; error?: string }> => {
    try {
      const data = await apiRequest<{ id: string }>("/api/workers", {
        method: "POST",
        body: { name, provider, workspacePath, model, accountId },
      });
      if (data.id) setActiveId(data.id);
      return { id: data.id };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const createAccount = useCallback(async (provider: ProviderId, label: string): Promise<{ data?: AccountWithAuth; error?: string }> => {
    try {
      const data = await apiRequest<{ account: AccountWithAuth }>("/api/accounts", {
        method: "POST",
        body: { provider, label },
      });
      setAccounts((current) => ({ ...current, [data.account.id]: data.account }));
      return { data: data.account };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const deleteAccount = useCallback(async (id: string): Promise<{ orphanedWorkerIds?: string[]; error?: string }> => {
    try {
      const data = await apiRequest<{ ok: boolean; orphanedWorkerIds: string[] }>(`/api/accounts/${id}`, {
        method: "DELETE",
      });
      setAccounts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setAccountUsage((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return { orphanedWorkerIds: data.orphanedWorkerIds };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const refreshAccount = useCallback(async (id: string): Promise<string | null> => {
    try {
      const data = await apiRequest<{ auth: ProviderAuthState | null }>(`/api/accounts/${id}/refresh`, { method: "POST" });
      if (data.auth) setAccounts((current) => (current[id] ? { ...current, [id]: { ...current[id], auth: data.auth } } : current));
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  // opts is Codex-only (mode/apiKey) — Claude accounts are browser-OAuth-only
  // and ignore it; the server-side route dispatches on the account's provider.
  const startAccountLogin = useCallback(async (
    id: string,
    opts?: { mode?: CodexAccountLoginMode; apiKey?: string },
  ): Promise<string | null> => {
    try {
      const data = await apiRequest<{ state: AccountLoginState }>(`/api/accounts/${id}/login`, {
        method: "POST",
        body: { mode: opts?.mode, apiKey: opts?.apiKey },
      });
      setAccountLogins((current) => ({ ...current, [id]: data.state }));
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  // Claude-only: submits the verification code pasted back after browser
  // authorization. Calling this for a Codex account fails server-side.
  const submitAccountLoginCode = useCallback(async (id: string, code: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/accounts/${id}/login/code`, { method: "POST", body: { code } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const cancelAccountLogin = useCallback(async (id: string): Promise<void> => {
    try {
      await apiRequest(`/api/accounts/${id}/login/cancel`, { method: "POST" });
    } catch {
      // best-effort — a WS account_login_result still lands if the process was already finishing.
    }
  }, []);

  const startDefaultCodexLogin = useCallback(async (mode: CodexAccountLoginMode, apiKey?: string): Promise<string | null> => {
    try {
      const data = await apiRequest<{ state: AccountLoginState }>("/api/auth/codex/login", {
        method: "POST",
        body: { mode, apiKey },
      });
      setDefaultCodexLogin(data.state);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const cancelDefaultCodexLogin = useCallback(async (): Promise<void> => {
    try {
      await apiRequest("/api/auth/codex/login/cancel", { method: "POST" });
    } catch {
      // best-effort — a WS codex_default_login_result still lands if the process was already finishing.
    }
  }, []);

  const startDefaultClaudeLogin = useCallback(async (): Promise<string | null> => {
    try {
      const data = await apiRequest<{ state: ClaudeLoginState }>("/api/auth/claude/login", { method: "POST" });
      setDefaultClaudeLogin(data.state);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const submitDefaultClaudeLoginCode = useCallback(async (code: string): Promise<string | null> => {
    try {
      await apiRequest("/api/auth/claude/login/code", { method: "POST", body: { code } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const cancelDefaultClaudeLogin = useCallback(async (): Promise<void> => {
    try {
      await apiRequest("/api/auth/claude/login/cancel", { method: "POST" });
    } catch {
      // best-effort — a WS claude_default_login_result still lands if the process was already finishing.
    }
  }, []);

  const setWorkerAccount = useCallback(async (workerId: string, accountId: string | null): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${workerId}/account`, { method: "PATCH", body: { accountId } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const pickWorkspace = useCallback(async (): Promise<{
    path?: string;
    canceled?: boolean;
    error?: string;
  }> => {
    try {
      const data = await apiRequest<{ path?: string; canceled?: boolean }>("/api/workspaces/pick", {
        method: "POST",
        timeoutMs: 125000,
      });
      return { path: data.path, canceled: Boolean(data.canceled) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const prepareHandoff = useCallback(async (
    id: string,
    toProvider: ProviderId,
    toModel: string | null = null,
  ): Promise<{ data?: PreparedHandoff; error?: string }> => {
    try {
      const data = await apiRequest<PreparedHandoff>(`/api/workers/${id}/handoff/prepare`, {
        method: "POST",
        body: { toProvider, toModel },
        timeoutMs: 35_000,
      });
      return { data };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const startHandoff = useCallback(async (
    id: string,
    handoffToken: string,
  ): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/handoff`, {
        method: "POST",
        body: { handoffToken, warningAcknowledged: true },
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const switchProviderFresh = useCallback(async (
    id: string,
    provider: ProviderId,
    model: string | null = null,
  ): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/provider/fresh`, {
        method: "POST",
        body: { provider, model },
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const prepareCollaboration = useCallback(async (input: {
    sourceWorkerId: string;
    targetWorkerId: string;
    mode: CollaborationMode;
    objective: string;
    acceptanceCriteria: string[];
  }): Promise<{ data?: PreparedCollaboration; error?: string }> => {
    try {
      const data = await apiRequest<PreparedCollaboration>(`/api/workers/${input.sourceWorkerId}/collaborations/prepare`, {
        method: "POST",
        body: input,
        timeoutMs: 35_000,
      });
      return { data };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const startCollaboration = useCallback(async (sourceWorkerId: string, collaborationToken: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${sourceWorkerId}/collaborations`, {
        method: "POST",
        body: { collaborationToken, warningAcknowledged: true },
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const collaborationAction = useCallback(async (id: string, action: "cancel" | "adopt" | "handled"): Promise<string | null> => {
    try {
      await apiRequest(`/api/collaborations/${id}/${action}`, { method: "POST" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const prepareMission = useCallback(async (input: {
    bossWorkerId: string;
    objective: string;
    acceptanceCriteria: string[];
    images?: CommandSubmission["images"];
    documents?: CommandSubmission["documents"];
    clientMessageId?: string;
    idempotencyKey?: string;
    parentMissionId?: string;
  }): Promise<{ data?: PreparedMission; error?: string }> => {
    try {
      const data = await apiRequest<PreparedMission>(`/api/workers/${input.bossWorkerId}/missions/prepare`, {
        method: "POST",
        body: input,
        timeoutMs: 35_000,
      });
      return { data };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const startMission = useCallback(async (bossWorkerId: string, missionToken: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${bossWorkerId}/missions`, {
        method: "POST",
        body: { missionToken, warningAcknowledged: true },
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const loadDepartmentThread = useCallback(async (departmentId: string): Promise<{ data?: DepartmentThreadPayload; error?: string }> => {
    try {
      return { data: await apiRequest<DepartmentThreadPayload>(`/api/departments/${departmentId}/thread`) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const messageDepartment = useCallback(async (
    departmentId: string,
    submission: CommandSubmission,
    acceptanceCriteria: string[] = [],
  ): Promise<{ data?: DepartmentThreadPayload; error?: string }> => {
    try {
      const data = await apiRequest<DepartmentThreadPayload>(`/api/departments/${departmentId}/messages`, {
        method: "POST",
        body: {
          message: submission.text,
          images: submission.images,
          documents: submission.documents,
          clientMessageId: submission.clientMessageId,
          idempotencyKey: submission.idempotencyKey,
          acceptanceCriteria,
        },
        timeoutMs: 135_000,
      });
      return { data };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const resetDepartmentSessions = useCallback(async (
    departmentId: string,
    confirm: boolean,
    workerIds?: string[],
    restartActiveMission = false,
  ): Promise<{ data?: { requiresConfirmation?: boolean; members?: Array<{ workerId: string; name: string; provider: ProviderId; model: string | null }>; results?: Array<{ workerId: string; name: string; ok: boolean; error: string | null }>; retryWorkerIds?: string[]; historyClearedAt?: string | null }; error?: string }> => {
    try {
      return { data: await apiRequest(`/api/departments/${departmentId}/sessions/reset`, {
        method: "POST",
        body: { confirm, workerIds, restartActiveMission },
        timeoutMs: 90_000,
      }) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const renameDepartment = useCallback(async (departmentId: string, name: string): Promise<string | null> => {
    try {
      const data = await apiRequest<{ department: Department }>(`/api/departments/${departmentId}`, {
        method: "PATCH",
        body: { name },
      });
      setDepartments((current) => ({ ...current, [data.department.id]: data.department }));
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const assignBossTask = useCallback(async (input: {
    objective: string;
    acceptanceCriteria: string[];
    preferredWorkspace?: string;
    decisionProvider?: ProviderId;
    decisionModel?: string;
    executionProfile?: "quick" | "standard" | "deep";
    maxAgents?: number;
    maxMissionSteps?: number;
    clarifications?: Array<{ question: string; answer: string }>;
  }): Promise<{ data?: BossAssignmentResponse; error?: string }> => {
    try {
      const data = await apiRequest<BossAssignmentResponse>("/api/assignments", {
        method: "POST",
        body: input,
        timeoutMs: 135_000,
      });
      return { data };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const createBossTask = useCallback(async (input: {
    message: string;
    acceptanceCriteria: string[];
    workspacePath: string;
    decisionProvider?: ProviderId;
    decisionModel?: string;
    images?: CommandSubmission["images"];
    documents?: CommandSubmission["documents"];
    clientMessageId?: string;
    idempotencyKey?: string;
  }): Promise<{ data?: BossTask; error?: string }> => {
    try {
      const data = await apiRequest<{ bossTask: BossTask }>("/api/boss-tasks", {
        method: "POST",
        body: input,
        timeoutMs: 135_000,
      });
      setBossTasks((current) => ({ ...current, [data.bossTask.id]: data.bossTask }));
      return { data: data.bossTask };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const messageBossTask = useCallback(async (id: string, submission: CommandSubmission): Promise<{ data?: BossTask; error?: string }> => {
    try {
      const data = await apiRequest<{ bossTask: BossTask }>(`/api/boss-tasks/${id}/messages`, {
        method: "POST",
        body: { message: submission.text, images: submission.images, documents: submission.documents, clientMessageId: submission.clientMessageId, idempotencyKey: submission.idempotencyKey },
        timeoutMs: 135_000,
      });
      setBossTasks((current) => ({ ...current, [data.bossTask.id]: data.bossTask }));
      return { data: data.bossTask };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const updateBossTask = useCallback(async (
    id: string,
    patch: { title?: string; archived?: boolean },
  ): Promise<{ data?: BossTask; error?: string }> => {
    try {
      const data = await apiRequest<{ bossTask: BossTask }>(`/api/boss-tasks/${id}`, {
        method: "PATCH",
        body: patch,
      });
      setBossTasks((current) => ({ ...current, [data.bossTask.id]: data.bossTask }));
      return { data: data.bossTask };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const deleteBossTask = useCallback(async (id: string): Promise<{ error?: string }> => {
    try {
      await apiRequest(`/api/boss-tasks/${id}`, { method: "DELETE" });
      setBossTasks((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return {};
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const restartBossTask = useCallback(async (id: string, confirm: boolean): Promise<{ data?: { members?: Array<{ name: string }>; missions?: Array<{ objective: string }>; bossTask?: BossTask }; error?: string }> => {
    try {
      const data = await apiRequest<{ members?: Array<{ name: string }>; missions?: Array<{ objective: string }>; bossTask?: BossTask }>(`/api/boss-tasks/${id}/restart`, {
        method: "POST",
        body: { confirm },
        timeoutMs: 135_000,
      });
      if (data.bossTask) setBossTasks((current) => ({ ...current, [data.bossTask!.id]: data.bossTask! }));
      return { data };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, []);

  const missionAction = useCallback(async (id: string, action: "cancel" | "retry-review" | "approve-plan"): Promise<string | null> => {
    try {
      await apiRequest(`/api/missions/${id}/${action}`, { method: "POST" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const resolveMission = useCallback(async (
    id: string,
    action: "retry" | "retry_execute" | "reassign" | "accept_risk" | "guide",
    guidance?: string,
    workerId?: string,
  ): Promise<string | null> => {
    try {
      await apiRequest(`/api/missions/${id}/resolve`, { method: "POST", body: { action, guidance, workerId } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const switchWorkspace = useCallback(async (
    id: string,
    workspacePath: string,
  ): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/workspace`, { method: "PATCH", body: { workspacePath } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  useEffect(() => {
    if (!activeId) return;
    void apiRequest(`/api/workers/${activeId}/activate`, { method: "POST" }).catch(() => undefined);
  }, [activeId]);

  const closeWorker = useCallback(async (id: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}`, { method: "DELETE" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const reorderWorkers = useCallback(async (newOrder: string[]): Promise<string | null> => {
    setOrder(newOrder);
    try {
      await apiRequest("/api/workers/order", { method: "PATCH", body: { order: newOrder } });
      return null;
    } catch (error) {
      // Re-sync from the server instead of restoring the pre-drag snapshot:
      // worker_added/worker_removed broadcasts may have landed in between.
      try {
        const data = await apiRequest<{ workers: Array<{ id: string }> }>("/api/workers");
        setOrder(data.workers.map((worker) => worker.id));
      } catch {
        // The WS snapshot on reconnect restores the authoritative order.
      }
      return (error as Error).message;
    }
  }, []);

  const renameWorker = useCallback(async (id: string, name: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}`, { method: "PATCH", body: { name } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const saveAvatar = useCallback(async (id: string, dataBase64: string, mimeType: "image/png" | "image/gif"): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/avatar`, { method: "PUT", body: { dataBase64, mimeType }, timeoutMs: 30000 });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const resetAvatar = useCallback(async (id: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/avatar`, { method: "DELETE" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const selectAvatarPreset = useCallback(async (id: string, presetId: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/avatar-preset`, { method: "PUT", body: { presetId } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const activateCustomAvatar = useCallback(async (id: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/avatar/custom`, { method: "POST" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const send = useCallback(async (id: string, command: CommandSubmission): Promise<string | null> => {
    try {
      await apiRequest<{ ok: boolean }>(`/api/workers/${id}/message`, {
        method: "POST",
        body: { message: command.text, images: command.images, documents: command.documents, clientMessageId: command.clientMessageId, idempotencyKey: command.idempotencyKey },
        timeoutMs: 30000,
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const askMission = useCallback(async (missionId: string, question: string): Promise<string | null> => {
    try {
      await apiRequest<{ ok: boolean; workerId: string }>(`/api/missions/${missionId}/follow-up`, {
        method: "POST",
        body: { question },
        timeoutMs: 30_000,
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const setModel = useCallback(async (id: string, model: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/model`, { method: "POST", body: { model } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const setModelFresh = useCallback(async (id: string, model: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/model/fresh`, { method: "POST", body: { model } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const setPersona = useCallback(async (id: string, persona: Persona | null): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/persona`, { method: "POST", body: { persona } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const setAutoApproveMode = useCallback(async (id: string, mode: AutoApproveMode): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/auto-approve`, { method: "POST", body: { mode } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const interrupt = useCallback(async (id: string): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/interrupt`, { method: "POST" });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const resolveApproval = useCallback(async (
    workerId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${workerId}/approvals/${approvalId}`, {
        method: "POST",
        body: { decision },
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const resolveMissionApproval = useCallback(async (
    missionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<string | null> => {
    try {
      await apiRequest(`/api/missions/${missionId}/approvals/${approvalId}`, {
        method: "POST",
        body: { decision },
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const refreshAuth = useCallback(async (provider?: ProviderId) => {
    try {
      const data = await apiRequest<{ auth: ProviderAuthState[] }>("/api/auth/refresh", {
        method: "POST",
        body: { provider },
      });
      if (Array.isArray(data.auth)) {
        setAuth((current) => ({
          ...current,
          ...Object.fromEntries(data.auth.map((item: ProviderAuthState) => [item.provider, item])),
        }));
      }
    } catch {
      // WebSocket connection state already communicates server availability.
    }
  }, []);

  const refreshUsage = useCallback(async (): Promise<string | null> => {
    try {
      const data = await apiRequest<{ usage: Record<ProviderId, ProviderUsageState>; accountUsage?: Record<string, ProviderUsageState> }>("/api/usage/refresh", { method: "POST", timeoutMs: 35_000 });
      setProviderUsage(data.usage);
      setAccountUsage(data.accountUsage ?? {});
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const installProvider = useCallback(async (provider: ProviderId): Promise<string | null> => {
    try {
      const started = await apiRequest<{ install: ProviderInstallState }>(`/api/providers/${provider}/install`, {
        method: "POST",
        timeoutMs: 15_000,
      });
      setProviderInstalls((current) => ({ ...current, [provider]: started.install }));
      let state = started.install;
      while (state.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const result = await apiRequest<{ install: ProviderInstallState }>(`/api/providers/${provider}/install`, {
          timeoutMs: 15_000,
        });
        state = result.install;
        setProviderInstalls((current) => ({ ...current, [provider]: state }));
      }
      await refreshAuth(provider);
      return state.status === "failed" ? state.error || t("安裝失敗") : null;
    } catch (error) {
      const message = (error as Error).message;
      setProviderInstalls((current) => ({
        ...current,
        [provider]: { ...current[provider], status: "failed", phase: t("安裝失敗"), error: message },
      }));
      return message;
    }
  }, [refreshAuth]);

  useEffect(() => {
    const pending = (Object.keys(auth) as ProviderId[]).filter(
      (provider) => auth[provider].status !== "authenticated" && auth[provider].status !== "checking",
    );
    if (pending.length === 0) return;
    const timer = setInterval(() => pending.forEach((provider) => void refreshAuth(provider)), 3000);
    return () => clearInterval(timer);
  }, [auth, refreshAuth]);

  return {
    workers,
    bossTasks,
    collaborations,
    missions,
    departments,
    order,
    mcpLoginResult,
    activeId,
    setActiveId,
    targetRepoPath,
    system,
    stats,
    updateInfo,
    workspacePaths,
    wsReady,
    capabilitiesByWorkspace,
    workflowRevisions,
    auth,
    providerUsage,
    accountUsage,
    providerInstalls,
    accounts,
    accountLogins,
    defaultCodexLogin,
    defaultClaudeLogin,
    createAccount,
    deleteAccount,
    refreshAccount,
    startAccountLogin,
    submitAccountLoginCode,
    cancelAccountLogin,
    startDefaultCodexLogin,
    cancelDefaultCodexLogin,
    startDefaultClaudeLogin,
    submitDefaultClaudeLoginCode,
    cancelDefaultClaudeLogin,
    setWorkerAccount,
    createWorker,
    pickWorkspace,
    prepareHandoff,
    startHandoff,
    switchProviderFresh,
    prepareCollaboration,
    startCollaboration,
    cancelCollaboration: (id: string) => collaborationAction(id, "cancel"),
    adoptCollaboration: (id: string) => collaborationAction(id, "adopt"),
    handleCollaboration: (id: string) => collaborationAction(id, "handled"),
    prepareMission,
    startMission,
    loadDepartmentThread,
    messageDepartment,
    resetDepartmentSessions,
    renameDepartment,
    assignBossTask,
    createBossTask,
    messageBossTask,
    updateBossTask,
    deleteBossTask,
    restartBossTask,
    cancelMission: (id: string) => missionAction(id, "cancel"),
    retryMissionReview: (id: string) => missionAction(id, "retry-review"),
    approveMissionPlan: (id: string) => missionAction(id, "approve-plan"),
    resolveMission,
    switchWorkspace,
    closeWorker,
    renameWorker,
    reorderWorkers,
    saveAvatar,
    resetAvatar,
    selectAvatarPreset,
    activateCustomAvatar,
    send,
    askMission,
    setModel,
    setModelFresh,
    setPersona,
    setAutoApproveMode,
    interrupt,
    resolveApproval,
    resolveMissionApproval,
    refreshAuth,
    refreshUsage,
    installProvider,
  };
}
