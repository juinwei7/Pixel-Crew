import { useCallback, useEffect, useRef, useState } from "react";
import type { CapabilityState, RunnerEvent, WorkerState } from "../types";
import { applyRunnerEvent, emptyWorker } from "../workerState";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";

type ServerMessage =
  | {
      type: "snapshot";
      targetRepoPath: string;
      capabilities: CapabilityState;
      workers: Array<{
        id: string;
        name: string;
        model: string | null;
        busy: boolean;
        colorIndex: number;
        events: RunnerEvent[];
      }>;
    }
  | { type: "event"; workerId: string; event: RunnerEvent }
  | { type: "worker_added"; worker: WorkerSummary }
  | { type: "worker_removed"; workerId: string }
  | { type: "worker_updated"; worker: WorkerSummary }
  | { type: "worker_status"; workerId: string; busy: boolean }
  | { type: "capabilities_updated"; capabilities: CapabilityState };

type WorkerSummary = {
  id: string;
  name: string;
  model: string | null;
  busy: boolean;
  colorIndex: number;
};

export function useWorkers() {
  const [workers, setWorkers] = useState<Record<string, WorkerState>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [targetRepoPath, setTargetRepoPath] = useState("");
  const [wsReady, setWsReady] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityState>({
    slashCommands: [],
    mcpServers: [],
    toolCount: null,
    loading: true,
    source: "empty",
    updatedAt: null,
    error: null,
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
          setCapabilities(data.capabilities);
          const record: Record<string, WorkerState> = {};
          const ids: string[] = [];
          for (const w of data.workers) {
            let state = emptyWorker(w.id, w.name, w.model, w.busy, w.colorIndex ?? 0);
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
            ),
          }));
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
            return {
              ...prev,
              [data.worker.id]: { ...w, name: data.worker.name, model: data.worker.model },
            };
          });
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
          setCapabilities(data.capabilities);
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

  const createWorker = useCallback(async (name?: string) => {
    const res = await fetch(`${SERVER_URL}/api/workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.id) setActiveId(data.id);
  }, []);

  const closeWorker = useCallback(async (id: string) => {
    await fetch(`${SERVER_URL}/api/workers/${id}`, { method: "DELETE" });
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

  return {
    workers,
    order,
    activeId,
    setActiveId,
    targetRepoPath,
    wsReady,
    capabilities,
    createWorker,
    closeWorker,
    send,
    setModel,
    interrupt,
  };
}
