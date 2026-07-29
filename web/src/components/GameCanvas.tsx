import { Fragment, useEffect, useRef, useState } from "react";
import type { ApprovalDecision, ApprovalItem, CollaborationTask, Department, DepartmentMission, WorkerState } from "../types";
import { createScene, type FurnitureScreenPos, type SceneHandle, type SceneView } from "../game/scene";
import { SHIRT_COLORS } from "../game/person";
import { chooseBubblePlacement, type BubbleRect } from "../game/bubbleLayout";
import { FURNITURE_DEFS } from "../game/furniture";
import { roomName } from "../workspace";
import { milestoneLevel } from "../milestones";
import type { StationKey } from "../stations";
import { NpcRadialMenu } from "./NpcRadialMenu";

const STATION_LABELS: Record<string, string> = Object.fromEntries(
  FURNITURE_DEFS.filter((def) => def.label).map((def) => [def.key, def.label]),
);

type VisualWorker = {
  id: string;
  selectId: string;
  name: string;
  character: WorkerState["character"];
  active: boolean;
  colorIndex: number;
  avatarId: string | null;
  avatarKind: WorkerState["avatarKind"];
  avatarPresetId: string;
  busy: boolean;
  temporary: boolean;
  waiting: boolean;
  provider: WorkerState["provider"];
  model: string | null;
  role: string | null;
  workspacePath: string;
  departmentKey: string;
  workspaceLabel: string;
  collaborationPhase: "reviewing" | "returning" | "planning" | "executing" | "mission_review" | "mission_consult" | "needs_attention" | null;
  collaborationRole: "source" | "target" | null;
  missionProgress: { completed: number; total: number } | null;
};

// Zoom is now continuous (not stepped to integers), so the readout needs a
// decimal — but whole numbers (the common auto-fit case) should still read
// as "4x" rather than "4.0x".
function formatZoom(scale: number): string {
  const rounded = Math.round(scale * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

function pendingApprovalFor(worker: WorkerState): ApprovalItem | null {
  const last = worker.turns[worker.turns.length - 1];
  return last?.items.find((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending") ?? null;
}

export function groupWorkersByWorkspace(workers: WorkerState[]): WorkerState[] {
  const groups = new Map<string, WorkerState[]>();
  for (const worker of workers) {
    const key = worker.departmentId ?? worker.workspacePath;
    const group = groups.get(key);
    if (group) group.push(worker);
    else groups.set(key, [worker]);
  }
  return [...groups.values()].flat();
}

export function radialMenuDirection(x: number, width: number): "left" | "right" {
  const edgeGuard = 110;
  if (x < edgeGuard) return "right";
  if (x > width - edgeGuard) return "left";
  return x < width / 2 ? "left" : "right";
}

function visualWorkers(workers: WorkerState[], activeId: string | null, collaborations: CollaborationTask[], missions: DepartmentMission[], departments: Department[] = []): VisualWorker[] {
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  return groupWorkersByWorkspace(workers).flatMap((worker) => {
    const handingOff = Boolean(worker.handoff && !["completed", "failed"].includes(worker.handoff.stage));
    const collaboration = collaborations.find((task) =>
      ["running", "returning"].includes(task.status) &&
      (task.sourceWorkerId === worker.id || task.targetWorkerId === worker.id),
    );
    const mission = missions.find((task) =>
      ["planning", "executing", "reviewing", "needs_attention"].includes(task.status)
      && (worker.departmentId ? task.departmentId === worker.departmentId : task.workspacePath === worker.workspacePath),
    );
    const missionStep = mission?.currentStepIndex == null ? null : mission.steps[mission.currentStepIndex];
    const parent: VisualWorker = {
      id: worker.id,
      selectId: worker.id,
      name: worker.name,
      character: handingOff ? { ...worker.character, activity: "thinking", station: "home", speech: "LLM 交接中…" } : worker.character,
      active: worker.id === activeId,
      colorIndex: worker.colorIndex,
      avatarId: worker.avatarId,
      avatarKind: worker.avatarKind,
      avatarPresetId: worker.avatarPresetId,
      busy: worker.busy,
      temporary: false,
      waiting: Boolean(pendingApprovalFor(worker)),
      provider: worker.provider,
      model: worker.model,
      role: worker.persona?.role ?? null,
      workspacePath: worker.workspacePath,
      departmentKey: worker.departmentId ?? worker.workspacePath,
      workspaceLabel: worker.departmentId ? departmentById.get(worker.departmentId)?.name ?? roomName(worker.workspacePath) : roomName(worker.workspacePath),
      collaborationPhase: mission?.status === "planning" ? "planning"
        : mission?.status === "executing" ? "executing"
        : mission?.status === "reviewing" && missionStep?.kind === "consult" ? "mission_consult"
        : mission?.status === "reviewing" ? "mission_review"
        : mission?.status === "needs_attention" ? "needs_attention"
        : collaboration?.status === "returning" ? "returning" : collaboration ? "reviewing" : null,
      collaborationRole: collaboration
        ? collaboration.sourceWorkerId === worker.id ? "source" : "target"
        : null,
      missionProgress: mission && mission.steps.length > 0 ? {
        completed: mission.steps.filter((step) => step.status === "completed").length,
        total: mission.steps.length,
      } : null,
    };
    const subagents: VisualWorker[] = (worker.subagents ?? []).map((agent, index) => ({
      id: `${worker.id}:subagent:${agent.id}`,
      selectId: worker.id,
      name: agent.name,
      character: {
        activity: "working",
        mood: "neutral",
        station: "meeting",
        speech: agent.background ? "背景作業中…" : agent.task,
        bump: 0,
      },
      active: false,
      colorIndex: (worker.colorIndex + index + 1) % SHIRT_COLORS.length,
      avatarId: null,
      avatarKind: "preset",
      avatarPresetId: "classic",
      busy: true,
      temporary: true,
      waiting: false,
      provider: worker.provider,
      model: worker.model,
      role: null,
      workspacePath: worker.workspacePath,
      departmentKey: worker.departmentId ?? worker.workspacePath,
      workspaceLabel: worker.departmentId ? departmentById.get(worker.departmentId)?.name ?? roomName(worker.workspacePath) : roomName(worker.workspacePath),
      collaborationPhase: null,
      collaborationRole: null,
      missionProgress: null,
    }));
    return [parent, ...subagents];
  });
}

type Props = {
  workers: WorkerState[];
  activeId: string | null;
  completedTurns?: number;
  collaborations?: CollaborationTask[];
  missions?: DepartmentMission[];
  departments?: Department[];
  onSelect(id: string): void;
  onOpenLog?(id: string): void;
  onAvatarError?(id: string, message: string): void;
  // Per-NPC quick actions, anchored directly on the sprite. Optional —
  // when omitted (e.g. in isolated tests) the "•••" trigger just doesn't
  // render, matching the existing onOpenLog/onAvatarError pattern.
  onRename?(id: string, name: string): Promise<string | null>;
  onAvatarWorkshop?(id: string): void;
  onPersonaEditor?(id: string): void;
  onDepartmentMission?(departmentKey: string, options?: { missionId?: string; focusSection?: "team" | "history" }): void;
  onRenameDepartment?(departmentId: string, name: string): Promise<string | null>;
  onRoomSwitch?(id: string): void;
  onRemove?(id: string): void;
  // Lets a pending approval be resolved right on the sprite instead of
  // requiring the task log panel to be open. Optional, same reasoning as above.
  onResolveApproval?(workerId: string, approvalId: string, decision: ApprovalDecision): Promise<string | null>;
};

export function GameCanvas({
  workers, activeId, completedTurns = 0, collaborations = [], missions = [], departments = [], onSelect, onOpenLog, onAvatarError,
  onRename, onAvatarWorkshop, onPersonaEditor, onDepartmentMission, onRenameDepartment, onRoomSwitch, onRemove, onResolveApproval,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const nameRefs = useRef(new Map<string, HTMLDivElement>());
  const identityRefs = useRef(new Map<string, HTMLDivElement>());
  const menuAnchorRefs = useRef(new Map<string, HTMLDivElement>());
  const approvalRefs = useRef(new Map<string, HTMLDivElement>());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [menuDirection, setMenuDirection] = useState<"left" | "right">("right");
  const [departmentRename, setDepartmentRename] = useState<{ key: string; x: number; y: number; name: string; saving: boolean; error: string | null } | null>(null);
  const departmentRenameInputRef = useRef<HTMLInputElement>(null);
  const departmentRenameActionRef = useRef<"idle" | "saving" | "cancel">("idle");
  const [resolvingApproval, setResolvingApproval] = useState<string | null>(null);
  const hasQuickMenu = Boolean(onRename && onAvatarWorkshop && onPersonaEditor && onRoomSwitch && onRemove);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [view, setView] = useState<SceneView | null>(null);
  const [furniturePositions, setFurniturePositions] = useState<Map<StationKey, FurnitureScreenPos>>(new Map());
  const [hoveredStation, setHoveredStation] = useState<StationKey | null>(null);
  const [pinnedStation, setPinnedStation] = useState<StationKey | null>(null);
  // Wall-clock start time per busy worker, purely for the "已執行 Ns" live
  // readout — not persisted, just a local ticking display.
  const turnStartRef = useRef(new Map<string, number>());
  const [, forceTick] = useState(0);
  const sceneRef = useRef<SceneHandle | null>(null);
  const screenPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const latest = useRef<{ workers: WorkerState[]; activeId: string | null }>({
    workers,
    activeId,
  });
  const latestCollaborations = useRef(collaborations);
  latestCollaborations.current = collaborations;
  const latestMissions = useRef(missions);
  latestMissions.current = missions;
  const latestDepartments = useRef(departments);
  latestDepartments.current = departments;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const milestoneRef = useRef(0);
  milestoneRef.current = milestoneLevel(completedTurns);
  const onAvatarErrorRef = useRef(onAvatarError);
  onAvatarErrorRef.current = onAvatarError;
  const onDepartmentMissionRef = useRef(onDepartmentMission);
  onDepartmentMissionRef.current = onDepartmentMission;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let handle: SceneHandle | null = null;
    const syncSceneSize = () => sceneRef.current?.resize();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(syncSceneSize);
    resizeObserver?.observe(host);

    createScene(host, {
      onPositions: (positions) => {
        const bounds = host.getBoundingClientRect();
        screenPositionsRef.current = new Map(positions.map((position) => [position.id, { x: position.x, y: position.y }]));
        for (const pos of positions) {
          const nameplate = nameRefs.current.get(pos.id);
          if (nameplate) {
            // Below the sprite's feet (pos.y is 17 art px above them, feet sit
            // 19 below pos.y at head-top anchor) — keeps the desk, monitor and
            // department sign above the head completely clear of DOM chrome.
            nameplate.style.transform = `translate(-50%, 0) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y + 22 * pos.scale}px)`;
            nameplate.style.opacity = String(pos.opacity);
          }
          const identity = identityRefs.current.get(pos.id);
          if (identity) {
            // Beside the sprite instead of on top of it; flip to the left
            // when the NPC stands near the right edge of the canvas.
            const sideGap = Math.round(14 + pos.scale * 4);
            const flip = pos.x + 230 + sideGap > bounds.width;
            identity.style.transform = flip
              ? `translate(calc(-100% - ${sideGap}px), -20%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)`
              : `translate(${sideGap}px, -20%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)`;
          }
          const menuAnchor = menuAnchorRefs.current.get(pos.id);
          if (menuAnchor) {
            menuAnchor.style.transform = `translate(-50%, 6px) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)`;
            // Lets the radial menu / trigger scale their offsets with the
            // camera zoom so they hug the sprite at any zoom level.
            menuAnchor.style.setProperty("--npc-zoom", (Math.max(4, pos.scale) / 4).toFixed(3));
          }
          const approval = approvalRefs.current.get(pos.id);
          if (approval) approval.style.transform = `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y - 34}px)`;
        }
        const occupied: BubbleRect[] = [];
        const ordered = [...positions].sort((a, b) =>
          Number(b.id === latest.current.activeId) - Number(a.id === latest.current.activeId),
        );
        for (const pos of ordered) {
          const bubble = bubbleRefs.current.get(pos.id);
          if (!bubble) continue;
          const hidden = bubble.classList.contains("robot-bubble--hidden");
          if (hidden) {
            bubble.style.opacity = "0";
            continue;
          }
          const width = bubble.offsetWidth || 140;
          const height = bubble.offsetHeight || 44;
          const placement = chooseBubblePlacement(
            pos.x,
            pos.y - 20,
            width,
            height,
            bounds.width,
            bounds.height,
            occupied,
          );
          occupied.push(placement.rect);
          bubble.style.transform = `translate(-50%, -100%) translate(${bounds.left + placement.x}px, ${bounds.top + placement.bottom}px)`;
          const compact = bubble.classList.contains("robot-bubble--compact");
          bubble.style.opacity = String(pos.opacity * (compact ? 0.72 : 1));
        }
      },
      onSelect: (id) => onSelectRef.current(id),
      onOpen: (id) => {
        onSelectRef.current(id);
        onOpenLog?.(id);
      },
      onHover: setHoveredId,
      onAvatarError: (id, message) => onAvatarErrorRef.current?.(id, message),
      onFurniturePositions: (list) => setFurniturePositions(new Map(list.map((pos) => [pos.key, pos]))),
      onFurnitureHover: setHoveredStation,
      onFurnitureClick: (key) => setPinnedStation((current) => (current === key ? null : key)),
      onDepartmentClick: (departmentKey) => onDepartmentMissionRef.current?.(departmentKey),
      onDepartmentRename: onRenameDepartment ? (departmentKey, position) => {
        const department = latestDepartments.current.find((candidate) => candidate.id === departmentKey);
        if (!department) return;
        const bounds = host.getBoundingClientRect();
        departmentRenameActionRef.current = "idle";
        setDepartmentRename({
          key: departmentKey,
          x: bounds.left + position.x,
          y: bounds.top + position.y,
          name: department.name,
          saving: false,
          error: null,
        });
      } : undefined,
      onContextMenu: (id) => {
        const position = screenPositionsRef.current.get(id);
        if (position) setMenuDirection(radialMenuDirection(position.x, host.getBoundingClientRect().width));
        setMenuOpenFor(id);
      },
      onViewChange: setView,
    }).then((h) => {
      if (cancelled) {
        h.destroy();
        return;
      }
      handle = h;
      sceneRef.current = h;
      // The host may have completed its first responsive layout (including
      // the persisted Crew rail width) while Pixi was initializing.
      // Synchronize immediately so users never have to nudge a panel first.
      syncSceneSize();
      setSceneError(null);
      h.setMilestone(milestoneRef.current);
      pushWorkers();
    }).catch((error: unknown) => {
      // Most commonly WebGL being unavailable (hardware acceleration off,
      // remote desktop, blocklisted GPU driver). Without this the office
      // just renders as a silent black area with the bubbles piled top-left.
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error("Pixel office scene failed to start:", error);
      setSceneError(message);
    });

    function pushWorkers() {
      sceneRef.current?.setWorkers(visualWorkers(latest.current.workers, latest.current.activeId, latestCollaborations.current, latestMissions.current, latestDepartments.current));
    }

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      handle?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = { workers, activeId };
    sceneRef.current?.setWorkers(visualWorkers(workers, activeId, collaborations, missions, departments));
  }, [workers, activeId, collaborations, missions, departments]);


  useEffect(() => {
    sceneRef.current?.setMilestone(milestoneLevel(completedTurns));
  }, [completedTurns]);

  useEffect(() => {
    const starts = turnStartRef.current;
    const busyIds = new Set(workers.filter((w) => w.busy).map((w) => w.id));
    for (const id of busyIds) if (!starts.has(id)) starts.set(id, Date.now());
    for (const id of [...starts.keys()]) if (!busyIds.has(id)) starts.delete(id);
    if (busyIds.size === 0) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [workers]);

  useEffect(() => {
    if (!pinnedStation) return;
    // Clicks inside the canvas are already handled by the scene's own
    // furniture click callback (which does its own pin/unpin toggle); this
    // only needs to close the tooltip for clicks elsewhere on the page.
    const unpin = (event: PointerEvent) => {
      if (hostRef.current?.contains(event.target as Node)) return;
      setPinnedStation(null);
    };
    window.addEventListener("pointerdown", unpin);
    return () => window.removeEventListener("pointerdown", unpin);
  }, [pinnedStation]);

  useEffect(() => {
    if (!menuOpenFor) return;
    const anchor = menuAnchorRefs.current.get(menuOpenFor);
    const close = (event: PointerEvent) => {
      if (anchor?.contains(event.target as Node)) return;
      setMenuOpenFor(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpenFor]);

  useEffect(() => {
    if (!departmentRename) return;
    departmentRenameInputRef.current?.focus();
    departmentRenameInputRef.current?.select();
  }, [departmentRename?.key]);


  if (sceneError) {
    return (
      <>
        <div className="game-host" ref={hostRef} />
        <div className="game-host__fallback" role="alert">
          <strong>像素辦公室無法啟動</strong>
          <p>這台裝置的瀏覽器拿不到 WebGL（常見原因：Chrome 硬體加速被關閉、遠端桌面連線、或顯示卡驅動被瀏覽器停用）。NPC 對話與任務日誌不受影響，仍可正常下指令。</p>
          <p>可以檢查 <code>chrome://gpu</code> 的 WebGL 狀態，或到瀏覽器設定開啟「使用硬體加速」。</p>
          <small>{sceneError}</small>
        </div>
      </>
    );
  }

  const allVisual = visualWorkers(workers, activeId, collaborations, missions, departments);
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));

  return (
    <>
      <div className="game-host" ref={hostRef} />
      {view && (
        <div className="canvas-zoom" role="group" aria-label="畫面縮放">
          <button
            type="button"
            aria-label="縮小"
            disabled={view.scale <= view.minScale}
            onClick={() => sceneRef.current?.setZoom(view.scale - 0.5)}
          >−</button>
          <input
            type="range"
            aria-label="縮放倍率"
            min={view.minScale}
            max={view.maxScale}
            step={0.05}
            value={view.scale}
            onChange={(event) => sceneRef.current?.setZoom(Number(event.target.value))}
          />
          <button
            type="button"
            aria-label="放大"
            disabled={view.scale >= view.maxScale}
            onClick={() => sceneRef.current?.setZoom(view.scale + 0.5)}
          >＋</button>
          <span className="canvas-zoom__value">{formatZoom(view.scale)}</span>
          <button
            type="button"
            className="canvas-zoom__reset"
            aria-label="恢復預設視角"
            title="恢復預設視角（大小與位置）"
            disabled={view.isDefault}
            onClick={() => sceneRef.current?.resetView()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 0 1 14-4.5" /><path d="M18 2v4h-4" /><path d="M20 14a8 8 0 0 1-14 4.5" /><path d="M6 22v-4h4" /></svg>
          </button>
        </div>
      )}
      {departmentRename && (() => {
        const save = async () => {
          if (departmentRename.saving || departmentRenameActionRef.current !== "idle") return;
          const name = departmentRename.name.trim();
          const original = departments.find((candidate) => candidate.id === departmentRename.key)?.name;
          if (!name) {
            setDepartmentRename((current) => current ? { ...current, error: "請輸入部門名稱" } : null);
            return;
          }
          if (name === original) {
            departmentRenameActionRef.current = "cancel";
            setDepartmentRename(null);
            return;
          }
          departmentRenameActionRef.current = "saving";
          setDepartmentRename((current) => current ? { ...current, saving: true, error: null } : null);
          const error = await onRenameDepartment?.(departmentRename.key, name);
          if (error) {
            departmentRenameActionRef.current = "idle";
            setDepartmentRename((current) => current ? { ...current, saving: false, error } : null);
            return;
          }
          setDepartmentRename(null);
        };
        return <form
          className="department-rename"
          style={{ left: departmentRename.x, top: departmentRename.y }}
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <input
            ref={departmentRenameInputRef}
            aria-label="編輯部門名稱"
            maxLength={80}
            value={departmentRename.name}
            disabled={departmentRename.saving}
            onChange={(event) => setDepartmentRename((current) => current ? { ...current, name: event.target.value, error: null } : null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                departmentRenameActionRef.current = "cancel";
                setDepartmentRename(null);
              }
            }}
            onBlur={() => {
              if (departmentRenameActionRef.current === "idle") void save();
            }}
          />
          {departmentRename.error && <small>{departmentRename.error}</small>}
        </form>;
      })()}
      {allVisual.map((w) => {
        const collaboration = !w.temporary ? collaborations.find((task) => ["running", "returning"].includes(task.status) && (task.sourceWorkerId === w.id || task.targetWorkerId === w.id)) : undefined;
        const mission = !w.temporary ? missions.find((task) => ["planning", "executing", "reviewing", "needs_attention"].includes(task.status) && (task.departmentId ? task.departmentId === w.departmentKey : task.workspacePath === w.workspacePath)) : undefined;
        const missionStep = mission?.currentStepIndex == null ? null : mission.steps[mission.currentStepIndex];
        const collaboratorId = collaboration?.sourceWorkerId === w.id ? collaboration.targetWorkerId : collaboration?.sourceWorkerId;
        const collaborator = collaboratorId ? workersById.get(collaboratorId) : undefined;
        const speech = w.character.speech.trim();
        const isActive = w.id === activeId;
        const compact = !isActive;
        const compactSpeech = speech || (w.busy ? "執行中…" : "");
        const source = isActive ? speech : w.busy ? compactSpeech : "";
        const maxSpeech = isActive ? 150 : 38;
        const shown = source.length > maxSpeech ? `…${source.slice(-maxSpeech)}` : source;
        const [shirtColor] = SHIRT_COLORS[w.colorIndex % SHIRT_COLORS.length];
        const accent = `#${shirtColor.toString(16).padStart(6, "0")}`;
        const startedAt = turnStartRef.current.get(w.id);
        const elapsedSec = w.busy && startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
        return (
          <Fragment key={w.id}>
            <div
              ref={(el) => {
                if (el) nameRefs.current.set(w.id, el);
                else nameRefs.current.delete(w.id);
              }}
              className={[
                "npc-nameplate",
                isActive ? "npc-nameplate--active" : "",
                w.busy ? "npc-nameplate--busy" : "",
                w.temporary ? "npc-nameplate--subagent" : "",
              ].join(" ")}
              style={{ borderColor: accent }}
            >
              <span className="npc-nameplate__name">{w.name}</span>
              {w.role && <span className="npc-nameplate__role">{w.role}</span>}
              {elapsedSec != null && <span className="npc-nameplate__elapsed">{elapsedSec}s</span>}
              {collaboration && <span className="npc-nameplate__collaboration" title={collaboration.objective}>
                {collaboration.status === "returning"
                  ? `${collaboration.sourceWorkerId === w.id ? "接續完成中" : "結果已交回"} · ${collaborator?.name ?? "NPC"}`
                  : `${collaboration.sourceWorkerId === w.id ? "委派中" : "協作執行中"} · ${collaborator?.name ?? "NPC"}`}
              </span>}
              {mission && <span className="npc-nameplate__collaboration npc-nameplate__mission" title={mission.objective}>
                {mission.status === "planning" && mission.bossWorkerId === w.id ? "部門工作規劃中" : missionStep?.assigneeWorkerId === w.id ? `${missionStep.kind === "review" ? "REVIEW" : missionStep.kind === "consult" ? "CONSULT" : "MISSION"} · ${missionStep.title}` : "部門工作"}
              </span>}
            </div>
            <div
              ref={(el) => {
                if (el) bubbleRefs.current.set(w.id, el);
                else bubbleRefs.current.delete(w.id);
              }}
              className={[
                "robot-bubble",
                shown ? "" : "robot-bubble--hidden",
                isActive ? "" : "robot-bubble--inactive",
                compact ? "robot-bubble--compact" : "",
                !isActive && w.busy ? "robot-bubble--busy" : "",
                w.temporary ? "robot-bubble--subagent" : "",
              ].join(" ")}
            >
              {shown}
            </div>
            {hoveredId === w.id && !w.temporary && menuOpenFor !== w.id && (
              <div ref={(element) => {
                if (element) identityRefs.current.set(w.id, element);
                else identityRefs.current.delete(w.id);
              }} className="npc-identity-card">
                <strong>{w.name}</strong>
                <span>{w.character.activity === "working" ? "執行中" : w.busy ? "思考中" : "待命"}</span>
                {w.role && <small className="npc-identity-card__role">{w.role}</small>}
                <small>{w.provider === "claude" ? "Claude Code" : "Codex"} · {w.model || "預設模型"}</small>
                <small>{roomName(w.workspacePath)}</small>
              </div>
            )}
            {hasQuickMenu && !w.temporary && menuOpenFor === w.id && (
              <div
                ref={(element) => {
                  if (element) menuAnchorRefs.current.set(w.id, element);
                  else menuAnchorRefs.current.delete(w.id);
                }}
                className="npc-menu-anchor"
              >
                {workersById.get(w.selectId) && (
                  <NpcRadialMenu
                    worker={workersById.get(w.selectId)!}
                    canRemove={workers.length > 1}
                    onRename={onRename!}
                    onAvatar={onAvatarWorkshop!}
                    onPersona={onPersonaEditor!}
                    onRoom={onRoomSwitch!}
                    onRemove={onRemove!}
                    onClose={() => setMenuOpenFor(null)}
                    direction={menuDirection}
                  />
                )}
              </div>
            )}
            {!w.temporary && onResolveApproval && (() => {
              const worker = workersById.get(w.selectId);
              const pending = worker && pendingApprovalFor(worker);
              if (!worker || !pending) return null;
              const busyKey = `${worker.id}:${pending.request.id}`;
              const decide = (decision: ApprovalDecision) => {
                setResolvingApproval(busyKey);
                void onResolveApproval(worker.id, pending.request.id, decision).finally(() => setResolvingApproval(null));
              };
              return (
                <div
                  ref={(element) => {
                    if (element) approvalRefs.current.set(w.id, element);
                    else approvalRefs.current.delete(w.id);
                  }}
                  className="npc-approval-bar"
                >
                  <strong>{pending.request.title}</strong>
                  <div className="npc-approval-bar__actions">
                    <button type="button" disabled={resolvingApproval === busyKey} onClick={() => decide("deny")}>拒絕</button>
                    {pending.request.decisions.includes("allow_session") && (
                      <button type="button" disabled={resolvingApproval === busyKey} onClick={() => decide("allow_session")}>本次皆允許</button>
                    )}
                    <button type="button" className="npc-approval-bar__allow" disabled={resolvingApproval === busyKey} onClick={() => decide("allow_once")}>允許</button>
                  </div>
                </div>
              );
            })()}
          </Fragment>
        );
      })}
      {(() => {
        const activeStation = hoveredStation ?? pinnedStation;
        const pos = activeStation ? furniturePositions.get(activeStation) : null;
        if (!activeStation || !pos) return null;
        const bounds = hostRef.current?.getBoundingClientRect();
        if (!bounds) return null;
        const occupants = allVisual.filter((w) => !w.temporary && w.character.station === activeStation);
        return (
          <div
            className="station-tooltip"
            style={{ transform: `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)` }}
          >
            <strong>{STATION_LABELS[activeStation] ?? activeStation}</strong>
            {occupants.length === 0
              ? <small>目前沒有人在使用</small>
              : occupants.map((w) => <small key={w.id}>{w.name}</small>)}
          </div>
        );
      })()}
    </>
  );
}
