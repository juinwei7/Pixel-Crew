import { useCallback, useEffect, useRef, useState } from "react";
import type { CapabilityState, ProviderAuthState, ProviderId, RunnerEvent, WorkerState } from "../types";
import { applyRunnerEvent, emptyWorker } from "../workerState";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";

type ServerMessage =
  | {
      type: "snapshot";
      targetRepoPath: string;
      workspacePaths: string[];
      auth: ProviderAuthState[];
      capabilities: Record<ProviderId, CapabilityState>;
      workers: Array<{
        id: string;
        name: string;
        model: string | null;
        busy: boolean;
        colorIndex: number;
        provider: ProviderId;
        workspacePath: string;
        events: RunnerEvent[];
      }>;
    }
  | { type: "event"; workerId: string; event: RunnerEvent }
  | { type: "worker_added"; worker: WorkerSummary }
  | { type: "worker_removed"; workerId: string }
  | { type: "worker_updated"; worker: WorkerSummary; reset?: boolean }
  | { type: "worker_status"; workerId: string; busy: boolean }
  | { type: "capabilities_updated"; provider: ProviderId; capabilities: CapabilityState }
  | { type: "auth_updated"; auth: ProviderAuthState };

type WorkerSummary = {
  id: string;
  name: string;
  model: string | null;
  busy: boolean;
  colorIndex: number;
  provider: ProviderId;
  workspacePath: string;
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
  const [capabilities, setCapabilities] = useState<Record<ProviderId, CapabilityState>>({
    claude: emptyCapabilities(),
    codex: emptyCapabilities(),
  });
  const [auth, setAuth] = useState<Record<ProviderId, ProviderAuthState>>({
    claude: defaultAuth("claude", "Claude Code", "claude auth login"),
    codex: defaultAuth("codex", "Codex", "codex login"),
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
          setWorkspacePaths(data.workspacePaths);
          setAuth(Object.fromEntries(data.auth.map((item) => [item.provider, item])) as Record<ProviderId, ProviderAuthState>);
          setCapabilities(data.capabilities);
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
            );
            for (const event of w.events) state = applyRunnerEvent(state, event);
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
          setCapabilities((current) => ({ ...current, [data.provider]: data.capabilities }));
          break;
        }
        case "auth_updated": {
          setAuth((current) => ({ ...current, [data.auth.provider]: data.auth }));
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
    const res = await fetch(`${SERVER_URL}/api/workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, provider, workspacePath }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.id) setActiveId(data.id);
    return res.ok ? { id: data.id } : { error: data.error ?? "無法建立 Worker" };
  }, []);

  const pickWorkspace = useCallback(async (): Promise<{
    path?: string;
    canceled?: boolean;
    error?: string;
  }> => {
    const res = await fetch(`${SERVER_URL}/api/workspaces/pick`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error ?? "無法開啟資料夾選擇器" };
    return { path: data.path, canceled: Boolean(data.canceled) };
  }, []);

  const switchProvider = useCallback(async (
    id: string,
    provider: ProviderId,
  ): Promise<string | null> => {
    const res = await fetch(`${SERVER_URL}/api/workers/${id}/provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? "無法切換 NPC 類型";
  }, []);

  const switchWorkspace = useCallback(async (
    id: string,
    workspacePath: string,
  ): Promise<string | null> => {
    const res = await fetch(`${SERVER_URL}/api/workers/${id}/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath }),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? "無法切換工作位置";
  }, []);

  useEffect(() => {
    if (!activeId) return;
    void fetch(`${SERVER_URL}/api/workers/${activeId}/activate`, { method: "POST" });
  }, [activeId]);

  const closeWorker = useCallback(async (id: string) => {
    await fetch(`${SERVER_URL}/api/workers/${id}`, { method: "DELETE" });
  }, []);

  const renameWorker = useCallback(async (id: string, name: string): Promise<string | null> => {
    const res = await fetch(`${SERVER_URL}/api/workers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? "改名失敗";
  }, []);

  const send = useCallback(async (id: string, message: string): Promise<string | null> => {
    const res = await fetch(`${SERVER_URL}/api/workers/${id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return data.error ?? "送出失敗";
    }
    return null;
  }, []);

  const setModel = useCallback(async (id: string, model: string) => {
    await fetch(`${SERVER_URL}/api/workers/${id}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  }, []);

  const interrupt = useCallback(async (id: string) => {
    await fetch(`${SERVER_URL}/api/workers/${id}/interrupt`, { method: "POST" });
  }, []);

  const refreshAuth = useCallback(async (provider?: ProviderId) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json().catch(() => ({}));
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
    workspacePaths,
    wsReady,
    capabilities,
    auth,
    createWorker,
    pickWorkspace,
    switchProvider,
    switchWorkspace,
    closeWorker,
    renameWorker,
    send,
    setModel,
    interrupt,
    refreshAuth,
  };
}
