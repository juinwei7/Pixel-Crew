import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalDecision, CapabilityState, CommandSubmission, HandoffProgress, Persona, PreparedHandoff, ProviderAuthState, ProviderId, ProviderInstallState, ProviderUsageState, RunnerEvent, WorkerState } from "../types";
import { applyRunnerEvent, emptyWorker } from "../workerState";
import { apiRequest } from "../api";

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
};

type ServerMessage =
  | {
      type: "snapshot";
      targetRepoPath: string;
      system?: SystemStatus;
      workspacePaths: string[];
      auth: ProviderAuthState[];
      providerUsage: Record<ProviderId, ProviderUsageState>;
      capabilitiesByWorkspace: Record<string, Record<ProviderId, CapabilityState>>;
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
        persona: Persona | null;
        autoApprove: boolean;
        handoff: HandoffProgress | null;
        events: RunnerEvent[];
      }>;
    }
  | { type: "event"; workerId: string; event: RunnerEvent }
  | { type: "worker_added"; worker: WorkerSummary }
  | { type: "worker_removed"; workerId: string }
  | { type: "worker_updated"; worker: WorkerSummary; reset?: boolean }
  | { type: "worker_status"; workerId: string; busy: boolean }
  | { type: "capabilities_updated"; workspacePath: string; provider: ProviderId; capabilities: CapabilityState }
  | { type: "workflow_library_updated"; workspacePath: string; provider: ProviderId; revision: number }
  | { type: "auth_updated"; auth: ProviderAuthState }
  | { type: "usage_updated"; provider: ProviderId; usage: ProviderUsageState };

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
  persona: Persona | null;
  autoApprove: boolean;
  handoff: HandoffProgress | null;
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
  };
}

export function useWorkers() {
  const [workers, setWorkers] = useState<Record<string, WorkerState>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [targetRepoPath, setTargetRepoPath] = useState("");
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [wsReady, setWsReady] = useState(false);
  const emptyCapabilities = (): CapabilityState => ({
    slashCommands: [],
    mcpServers: [],
    models: [],
    toolCount: null,
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
  const emptyInstall = (provider: ProviderId): ProviderInstallState => ({
    provider, status: "idle", phase: "尚未開始", command: "", sourceUrl: "",
    startedAt: null, finishedAt: null, output: "", error: null,
  });
  const [providerInstalls, setProviderInstalls] = useState<Record<ProviderId, ProviderInstallState>>({
    claude: emptyInstall("claude"),
    codex: emptyInstall("codex"),
  });
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      socket = new WebSocket(`${WS_URL}/ws`);
      socket.onopen = () => setWsReady(true);
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
          setWorkspacePaths(data.workspacePaths);
          setAuth(Object.fromEntries(data.auth.map((item) => [item.provider, item])) as Record<ProviderId, ProviderAuthState>);
          setProviderUsage(data.providerUsage ?? { claude: emptyUsage("claude"), codex: emptyUsage("codex") });
          setCapabilitiesByWorkspace(data.capabilitiesByWorkspace ?? {});
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
              w.autoApprove ?? false,
            );
            for (const event of w.events) state = applyRunnerEvent(state, event);
            // A persisted running turn cannot still have a live provider
            // callback after the server restarted. Close it honestly instead
            // of leaving a dead approval card clickable forever. A normal
            // browser reconnect preserves it because the worker is still busy.
            if (!w.busy && state.turns[state.turns.length - 1]?.status === "running") {
              state = applyRunnerEvent(state, {
                type: "error",
                message: "工作階段已中止；請重新下指令",
              });
            }
            state.busy = w.busy;
            record[w.id] = state;
            ids.push(w.id);
          }
          setWorkers(record);
          setOrder(ids);
          setActiveId((cur) => (cur && record[cur] ? cur : ids[0] ?? null));
          break;
        }
        case "event": {
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
            [data.worker.id]: emptyWorker(
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
              data.worker.autoApprove,
            ),
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
        case "worker_updated": {
          setWorkers((prev) => {
            const w = prev[data.worker.id];
            if (!w) return prev;
            const updated = !data.reset && w.provider === data.worker.provider
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
                  data.worker.autoApprove,
                );
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
        case "workflow_library_updated": {
          setWorkflowRevisions((current) => ({
            ...current,
            [`${data.provider}\0${data.workspacePath}`]: data.revision,
          }));
          break;
        }
        case "auth_updated": {
          setAuth((current) => ({ ...current, [data.auth.provider]: data.auth }));
          break;
        }
        case "usage_updated": {
          setProviderUsage((current) => ({ ...current, [data.provider]: data.usage }));
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

  const createWorker = useCallback(async (
    name?: string,
    provider: ProviderId = "claude",
    workspacePath?: string,
  ): Promise<{ id?: string; error?: string }> => {
    try {
      const data = await apiRequest<{ id: string }>("/api/workers", {
        method: "POST",
        body: { name, provider, workspacePath },
      });
      if (data.id) setActiveId(data.id);
      return { id: data.id };
    } catch (error) {
      return { error: (error as Error).message };
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
        body: { message: command.text, images: command.images, documents: command.documents },
        timeoutMs: 30000,
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

  const setPersona = useCallback(async (id: string, persona: Persona | null): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/persona`, { method: "POST", body: { persona } });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, []);

  const setAutoApprove = useCallback(async (id: string, enabled: boolean): Promise<string | null> => {
    try {
      await apiRequest(`/api/workers/${id}/auto-approve`, { method: "POST", body: { enabled } });
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
      const data = await apiRequest<{ usage: Record<ProviderId, ProviderUsageState> }>("/api/usage/refresh", { method: "POST", timeoutMs: 35_000 });
      setProviderUsage(data.usage);
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
      return state.status === "failed" ? state.error || "安裝失敗" : null;
    } catch (error) {
      const message = (error as Error).message;
      setProviderInstalls((current) => ({
        ...current,
        [provider]: { ...current[provider], status: "failed", phase: "安裝失敗", error: message },
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
    order,
    activeId,
    setActiveId,
    targetRepoPath,
    system,
    workspacePaths,
    wsReady,
    capabilitiesByWorkspace,
    workflowRevisions,
    auth,
    providerUsage,
    providerInstalls,
    createWorker,
    pickWorkspace,
    prepareHandoff,
    startHandoff,
    switchWorkspace,
    closeWorker,
    renameWorker,
    saveAvatar,
    resetAvatar,
    selectAvatarPreset,
    activateCustomAvatar,
    send,
    setModel,
    setPersona,
    setAutoApprove,
    interrupt,
    resolveApproval,
    refreshAuth,
    refreshUsage,
    installProvider,
  };
}
