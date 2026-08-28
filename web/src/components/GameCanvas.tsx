import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ApprovalDecision, ApprovalItem, CollaborationTask, Department, DepartmentMission, WorkerState } from "../types";
import { createScene, type FurnitureScreenPos, type SceneHandle, type SceneView } from "../game/scene";
import { SHIRT_COLORS } from "../game/person";
import { chooseBubblePlacement, type BubbleRect } from "../game/bubbleLayout";
import { FURNITURE_DEFS } from "../game/furniture";
import { roomName } from "../workspace";
import { milestoneLevel } from "../milestones";
import { stationForTool, type StationKey } from "../stations";
import { computeCtxGauge } from "../ctxGauge";
import { t } from "../i18n";
import { NpcRadialMenu } from "./NpcRadialMenu";
import { WebShotImg } from "./WebShotImg";

const STATION_LABELS: Record<string, string> = Object.fromEntries(
  FURNITURE_DEFS.filter((def) => def.label).map((def) => [def.key, def.label]),
);

// 站點用途說明：讓上排工作站的 tooltip 不只是名字，一眼看懂 NPC 來這裡是在做什麼。
const STATION_DESCRIPTIONS: Record<string, string> = {
  board: t("任務看板——NPC 檢視與領取待辦"),
  books: t("NPC 讀取專案檔案時會走到這"),
  code: t("寫程式／編輯檔案的工作站"),
  web: t("上網搜尋、查資料"),
  terminal: t("執行指令、跑測試、開伺服器"),
  check: t("驗證成果、檢查輸出"),
  desk: t("其他工具／MCP 呼叫"),
  meeting: t("作戰室會議桌——圓桌辯論在這開"),
};

// 工作小窗（SAMS 風）站點主題：對齊 3D officeScene 的一套，讓像素版也有「頭上浮螢幕」。
// kind=web 的小窗會放真實瀏覽器截圖(/api/webshot)；其餘顯示站點主題＋即時任務文字。
const WORKWINDOW_THEME: Record<string, { label: string; accent: string; kind: string }> = {
  terminal: { label: t("終端機"), accent: "#58f08a", kind: "term" },
  code:     { label: t("編輯器"), accent: "#7aa2ff", kind: "code" },
  web:      { label: t("瀏覽器"), accent: "#3f8cff", kind: "web" },
  books:    { label: t("知識庫"), accent: "#e0b060", kind: "docs" },
  check:    { label: t("驗證"),   accent: "#35d0b0", kind: "check" },
  board:    { label: t("看板"),   accent: "#b98cff", kind: "board" },
  meeting:  { label: t("白板"),   accent: "#8fd0ff", kind: "board" },
};

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

// 穩定的空集合預設值：避免每次 render 都 new Set() 造成參照改變、白白觸發下游重算。
const EMPTY_ROUNDTABLE_IDS: ReadonlySet<string> = new Set();

function visualWorkers(workers: WorkerState[], activeId: string | null, collaborations: CollaborationTask[], missions: DepartmentMission[], departments: Department[] = [], roundtableIds: ReadonlySet<string> = EMPTY_ROUNDTABLE_IDS): VisualWorker[] {
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
    // 開圓桌的 NPC：沿用場景既有的 thinking 姿勢＋speech 對話泡，冒出「🗣️ 圓桌討論中…」，
    // 讓使用者在畫面上直接看到「這位正在幫我開圓桌」。交接（handingOff）優先，兩者不會同時。
    // 作戰室 peer：名字以 🏛️ 開頭的臨時 NPC（由圓桌腳本建立）會被拉到「meeting」會議桌邊聚集，
    // 加上既有 roundtableMode 的臨時 NPC，一起呈現「一群人圍著大桌開會」的畫面。站到 meeting 站點後，
    // scene 的 standSpot 會自動把多個 NPC 錯開排在桌邊，不會重疊。
    const isWarRoomPeer = worker.name.codePointAt(0) === 0x1f3db; // 🏛 U+1F3DB：用碼位比對，避免 FE0F 變體選擇子不一致
    const roundtabling = !handingOff && (isWarRoomPeer || (roundtableIds.has(worker.id) && worker.busy));
    const parent: VisualWorker = {
      id: worker.id,
      selectId: worker.id,
      name: worker.name,
      character: handingOff ? { ...worker.character, activity: "thinking", station: "home", speech: t("LLM 交接中…") }
        : roundtabling ? { ...worker.character, activity: "thinking", station: "meeting", speech: worker.busy ? t("🗣️ 圓桌討論中…") : t("🗣️ 圓桌") }
        : worker.character,
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
        speech: agent.background ? t("背景作業中…") : agent.task,
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
  roundtableIds?: ReadonlySet<string>;
  /** 點擊作戰室會議桌時觸發（App 用它開圓桌模式並聚焦輸入框）。 */
  onMeetingTableClick?(): void;
  /** Tap on empty office floor — App uses it to dismiss the task log. */
  onEmptyTap?(): void;
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
  workers, activeId, completedTurns = 0, collaborations = [], missions = [], departments = [], roundtableIds = EMPTY_ROUNDTABLE_IDS, onMeetingTableClick, onEmptyTap, onSelect, onOpenLog, onAvatarError,
  onRename, onAvatarWorkshop, onPersonaEditor, onDepartmentMission, onRenameDepartment, onRoomSwitch, onRemove, onResolveApproval,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const nameRefs = useRef(new Map<string, HTMLDivElement>());
  const identityRefs = useRef(new Map<string, HTMLDivElement>());
  const menuAnchorRefs = useRef(new Map<string, HTMLDivElement>());
  const approvalRefs = useRef(new Map<string, HTMLDivElement>());
  const workWindowRefs = useRef(new Map<string, HTMLDivElement>());
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
  // 場景 callbacks 只在掛載時建一次，用 ref 拿最新的 onMeetingTableClick，避免閉包吃到舊值。
  const meetingClickRef = useRef(onMeetingTableClick);
  meetingClickRef.current = onMeetingTableClick;
  const emptyTapRef = useRef(onEmptyTap);
  emptyTapRef.current = onEmptyTap;
  // 工作小窗多行歷史：speech 每次變化就進每人滾動緩衝（收工清空）；終端機小窗用它演出像真 shell 的最近幾條指令。
  // 每行帶時間戳；cmds＝本回合累計指令數（標題列顯示）。
  const speechLogRef = useRef(new Map<string, { last: string; lines: Array<{ text: string; at: number }>; cmds: number }>());
  useEffect(() => {
    for (const w of workers) {
      const log = speechLogRef.current.get(w.id) ?? { last: "", lines: [], cmds: 0 };
      speechLogRef.current.set(w.id, log);
      if (!w.busy) { log.last = ""; log.lines.length = 0; log.cmds = 0; continue; }
      const sp = w.character.speech.trim();
      if (sp && sp !== log.last) {
        log.last = sp;
        // 時間戳用 server 蓋章的事件時間（speechAt），不用 render 當下——重整/重連重播歷史時才不會全變成「現在」
        log.lines.push({ text: sp, at: w.character.speechAt ?? Date.now() });
        if (/^執行指令[:：]/.test(sp)) log.cmds += 1;
        if (log.lines.length > 7) log.lines.shift();
      }
    }
  }, [workers]);

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
          // 工作小窗：浮在頭頂上方（比對話泡再高一點，避免打架）。
          const workWindow = workWindowRefs.current.get(pos.id);
          if (workWindow) {
            workWindow.style.transform = `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y - 30}px)`;
            workWindow.style.opacity = String(pos.opacity);
          }
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
      onSelect: (id) => {
        // Selecting an NPC must clear any station tooltip. On touch there is no
        // pointerout to end a furniture "hover", and the outside-click unpin
        // ignores in-canvas taps — so without this the war-room tooltip lingered
        // after tapping the table then an NPC.
        setPinnedStation(null);
        setHoveredStation(null);
        setHoveredId(null);
        onSelectRef.current(id);
      },
      onOpen: (id) => {
        setPinnedStation(null);
        setHoveredStation(null);
        setHoveredId(null);
        onSelectRef.current(id);
        onOpenLog?.(id);
      },
      onHover: setHoveredId,
      onAvatarError: (id, message) => onAvatarErrorRef.current?.(id, message),
      onFurniturePositions: (list) => setFurniturePositions(new Map(list.map((pos) => [pos.key, pos]))),
      onFurnitureHover: setHoveredStation,
      onFurnitureClick: (key) => {
        setPinnedStation((current) => (current === key ? null : key));
        if (key === "meeting") meetingClickRef.current?.(); // 點會議桌＝開圓桌模式
      },
      onEmptyTap: () => {
        // Tapping bare floor dismisses lingering hover UI (station tooltip + NPC
        // identity card, which touch can leave stuck with no pointerout) and
        // closes the task log — the phone "tap outside to dismiss" gesture.
        setPinnedStation(null);
        setHoveredStation(null);
        setHoveredId(null);
        emptyTapRef.current?.();
      },
      onDepartmentClick: (departmentKey) => { setPinnedStation(null); setHoveredStation(null); onDepartmentMissionRef.current?.(departmentKey); },
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
    sceneRef.current?.setWorkers(visualWorkers(workers, activeId, collaborations, missions, departments, roundtableIds));
  }, [workers, activeId, collaborations, missions, departments, roundtableIds]);


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
          <strong>{t("像素辦公室無法啟動")}</strong>
          <p>{t("這台裝置的瀏覽器拿不到 WebGL（常見原因：Chrome 硬體加速被關閉、遠端桌面連線、或顯示卡驅動被瀏覽器停用）。NPC 對話與任務日誌不受影響，仍可正常下指令。")}</p>
          <p>{t("可以檢查")} <code>chrome://gpu</code> {t("的 WebGL 狀態，或到瀏覽器設定開啟「使用硬體加速」。")}</p>
          <small>{sceneError}</small>
        </div>
      </>
    );
  }

  const allVisual = visualWorkers(workers, activeId, collaborations, missions, departments, roundtableIds);
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));

  return (
    <>
      <div className="game-host" ref={hostRef} />
      {view && (
        <div className="canvas-zoom" role="group" aria-label={t("畫面縮放")}>
          <button
            type="button"
            aria-label={t("縮小")}
            disabled={view.scale <= view.minScale}
            onClick={() => sceneRef.current?.setZoom(view.scale - 0.5)}
          >−</button>
          <input
            type="range"
            aria-label={t("縮放倍率")}
            min={view.minScale}
            max={view.maxScale}
            step={0.05}
            value={view.scale}
            onChange={(event) => sceneRef.current?.setZoom(Number(event.target.value))}
          />
          <button
            type="button"
            aria-label={t("放大")}
            disabled={view.scale >= view.maxScale}
            onClick={() => sceneRef.current?.setZoom(view.scale + 0.5)}
          >＋</button>
          <span className="canvas-zoom__value">{formatZoom(view.scale)}</span>
          <button
            type="button"
            className="canvas-zoom__reset"
            aria-label={t("恢復預設視角")}
            title={t("恢復預設視角（大小與位置）")}
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
            setDepartmentRename((current) => current ? { ...current, error: t("請輸入部門名稱") } : null);
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
            aria-label={t("編輯部門名稱")}
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
        const compactSpeech = speech || (w.busy ? t("執行中…") : "");
        const source = isActive ? speech : w.busy ? compactSpeech : "";
        const maxSpeech = isActive ? 150 : 38;
        const shown = source.length > maxSpeech ? `…${source.slice(-maxSpeech)}` : source;
        const [shirtColor] = SHIRT_COLORS[w.colorIndex % SHIRT_COLORS.length];
        const accent = `#${shirtColor.toString(16).padStart(6, "0")}`;
        const startedAt = turnStartRef.current.get(w.id);
        const elapsedSec = w.busy && startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
        // 工作小窗：忙碌且站點有主題才浮出；web 站點放真實瀏覽器截圖。開窗時就不再另外顯示 speech 泡（避免重複）。
        const winStation = w.character.station;
        const winTheme = w.busy && winStation ? WORKWINDOW_THEME[winStation] : undefined;
        const winQuery = w.character.webQuery?.trim() || "";
        const showWindow = !!winTheme;
        const bubbleShown = showWindow ? "" : shown;
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
                  ? t("{status} · {name}", { status: collaboration.sourceWorkerId === w.id ? t("接續完成中") : t("結果已交回"), name: collaborator?.name ?? "NPC" })
                  : t("{status} · {name}", { status: collaboration.sourceWorkerId === w.id ? t("委派中") : t("協作執行中"), name: collaborator?.name ?? "NPC" })}
              </span>}
              {mission && <span className="npc-nameplate__collaboration npc-nameplate__mission" title={mission.objective}>
                {mission.status === "planning" && mission.bossWorkerId === w.id ? t("部門工作規劃中") : missionStep?.assigneeWorkerId === w.id ? `${missionStep.kind === "review" ? "REVIEW" : missionStep.kind === "consult" ? "CONSULT" : "MISSION"} · ${missionStep.title}` : t("部門工作")}
              </span>}
            </div>
            <div
              ref={(el) => {
                if (el) bubbleRefs.current.set(w.id, el);
                else bubbleRefs.current.delete(w.id);
              }}
              className={[
                "robot-bubble",
                bubbleShown ? "" : "robot-bubble--hidden",
                isActive ? "" : "robot-bubble--inactive",
                compact ? "robot-bubble--compact" : "",
                !isActive && w.busy ? "robot-bubble--busy" : "",
                w.temporary ? "robot-bubble--subagent" : "",
              ].join(" ")}
            >
              {bubbleShown}
            </div>
            {showWindow && winTheme && (
              <div
                ref={(el) => {
                  if (el) workWindowRefs.current.set(w.id, el);
                  else workWindowRefs.current.delete(w.id);
                }}
                className={`npc-workwindow npc-workwindow--${winTheme.kind}${w.character.mood === "error" ? " npc-workwindow--error" : w.character.mood === "success" ? " npc-workwindow--success" : ""}`}
                style={{ "--ww-accent": winTheme.accent } as CSSProperties}
              >
                <div className="npc-workwindow__bar">
                  <span className="npc-workwindow__title">{winTheme.label}</span>
                  <span className="npc-workwindow__bar-right">
                    {winTheme.kind === "term" && (speechLogRef.current.get(w.id)?.cmds ?? 0) > 0 && (
                      <span className="npc-workwindow__meta">{speechLogRef.current.get(w.id)!.cmds} cmd</span>
                    )}
                    <span className="npc-workwindow__dot" />
                  </span>
                </div>
                {winTheme.kind === "web" ? (
                  <div className="npc-workwindow__web">
                    <div className="npc-workwindow__url">{winQuery ? (/^https?:\/\//i.test(winQuery) ? winQuery : `search · ${winQuery}`) : `search · ${w.name}`}</div>
                    {winQuery ? (
                      <WebShotImg query={winQuery} imgClassName="npc-workwindow__shot" />
                    ) : (
                      <div className="npc-workwindow__loading">{t("載入實時畫面…")}</div>
                    )}
                  </div>
                ) : winTheme.kind === "term" ? (
                  <div className="npc-workwindow__body npc-workwindow__body--lines">
                    {(() => {
                      const raw = speechLogRef.current.get(w.id)?.lines.slice(-7) ?? [];
                      const src = raw.length ? raw : [{ text: w.character.speech.trim() || t("執行中…"), at: w.character.speechAt ?? Date.now() }];
                      // 真指令行才給 $ 提示符＋指令名高亮（其他動作用 ›）；連續重複行收合成一行 ×n；
                      // 過長行改中段省略，結尾的檔名/參數比開頭的路徑更有資訊量
                      const rows: Array<{ text: string; cmd: boolean; n: number; at: number }> = [];
                      for (const ln of src) {
                        const cmd = /^執行指令[:：]/.test(ln.text);
                        let text = ln.text.replace(/^執行指令[:：]\s*/, "");
                        if (text.length > 72) text = `${text.slice(0, 42)}…${text.slice(-28)}`;
                        const prev = rows[rows.length - 1];
                        if (prev && prev.text === text && prev.cmd === cmd) { prev.n += 1; prev.at = ln.at; }
                        else rows.push({ text, cmd, n: 1, at: ln.at });
                      }
                      const shownRows = rows.slice(-5);
                      return shownRows.map((row, i) => {
                        const cut = row.cmd ? row.text.indexOf(" ") : -1;
                        const head = row.cmd ? (cut > 0 ? row.text.slice(0, cut) : row.text) : "";
                        const rest = row.cmd ? (cut > 0 ? row.text.slice(cut) : "") : row.text;
                        return (
                          <div key={`${i}-${row.text.slice(0, 12)}`} className={`npc-workwindow__line${i === shownRows.length - 1 ? " npc-workwindow__line--cur" : ""}`}>
                            <span className={`npc-workwindow__prompt${row.cmd ? "" : " npc-workwindow__prompt--info"}`}>{row.cmd ? "$" : "›"}</span>
                            {head && <span className="npc-workwindow__cmd0">{head}</span>}
                            {rest}
                            {row.n > 1 && <span className="npc-workwindow__times">×{row.n}</span>}
                          </div>
                        );
                      });
                    })()}
                  </div>
                ) : (
                  <div className="npc-workwindow__body">
                    {winTheme.kind === "check" ? "☑ " : winTheme.kind === "board" ? "• " : ""}
                    {(w.character.speech.trim() || t("執行中…")).slice(0, 90)}
                  </div>
                )}
              </div>
            )}
            {hoveredId === w.id && !w.temporary && menuOpenFor !== w.id && (() => {
              const full = workersById.get(w.selectId);
              const doneTurns = full?.turns.filter((turn) => turn.status !== "running").length ?? 0;
              const totalCost = full?.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0) ?? 0;
              const autoMode = full?.autoApproveMode ?? "off";
              const autoLabel = autoMode === "invincible" ? t("⚡ 無限制") : autoMode === "full" ? t("完全自動") : autoMode === "safe" ? t("安全自動") : t("手動核准");
              const dept = full?.departmentId ? departments.find((candidate) => candidate.id === full.departmentId) : undefined;
              // 各回合 contextTokens 序列丟給 ctxGauge：扣掉出生底盤後換算「可用量」，
              // 條滿 100% = 換腦門檻 170k（觸發仍在 server 端，這裡純顯示）。
              const ctxSeries = full ? full.turns.map((turn) => turn.contextTokens).filter((n): n is number => typeof n === "number") : [];
              const ctxGauge = computeCtxGauge(ctxSeries);
              const ctxPct = ctxGauge?.pct ?? null;
              const ctxLevel = ctxPct === null ? null : ctxPct >= 85 ? "danger" : ctxPct >= 60 ? "warn" : "ok";
              return (
              <div ref={(element) => {
                if (element) identityRefs.current.set(w.id, element);
                else identityRefs.current.delete(w.id);
              }} className="npc-identity-card">
                <strong>{w.name}</strong>
                <span>{w.character.activity === "working" ? t("執行中") : w.busy ? t("思考中") : t("待命")}</span>
                {w.role && <small className="npc-identity-card__role">{w.role}</small>}
                <small>{w.provider === "claude" ? "Claude Code" : "Codex"} · {w.model || t("預設模型")}</small>
                <small>{dept ? `${dept.name} · ` : ""}{roomName(w.workspacePath)}</small>
                <div className="npc-identity-card__stats">
                  <span className="npc-identity-card__stat">{t("完成 {count}", { count: doneTurns })}</span>
                  {totalCost > 0 && <span className="npc-identity-card__stat">${totalCost < 1 ? totalCost.toFixed(3) : totalCost.toFixed(2)}</span>}
                  <span className={`npc-identity-card__stat npc-identity-card__auto npc-identity-card__auto--${autoMode}`}>{autoLabel}</span>
                </div>
                {ctxPct !== null && (
                  <div className={`npc-identity-card__ctx npc-identity-card__ctx--${ctxLevel}`} title={t("context 約 {current}k（底盤 {baseline}k 不計）；條滿 = 換腦門檻 170k", { current: Math.round((ctxGauge?.currentTokens ?? 0) / 1000), baseline: Math.round((ctxGauge?.baselineTokens ?? 0) / 1000) })}>
                    <span className="npc-identity-card__ctx-label">CTX</span>
                    <span className="npc-identity-card__ctx-track"><span className="npc-identity-card__ctx-fill" style={{ width: `${ctxPct}%` }} /></span>
                    <span className="npc-identity-card__ctx-pct">{ctxPct}%</span>
                  </div>
                )}
              </div>
              );
            })()}
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
                    <button type="button" disabled={resolvingApproval === busyKey} onClick={() => decide("deny")}>{t("拒絕")}</button>
                    {pending.request.decisions.includes("allow_session") && (
                      <button type="button" disabled={resolvingApproval === busyKey} onClick={() => decide("allow_session")}>{t("本次皆允許")}</button>
                    )}
                    <button type="button" className="npc-approval-bar__allow" disabled={resolvingApproval === busyKey} onClick={() => decide("allow_once")}>{t("允許")}</button>
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
        // 找出佔用者「正在跑的工具」（最後一個 turn 裡 status=running 的 tool_call），讓站點 tooltip
        // 變成即時儀表：不只知道誰在用，還知道它正在幹嘛。點名字可直接開那位的工作日誌。
        const runningToolOf = (workerId: string): { name: string; input: unknown } | null => {
          const turns = workers.find((w) => w.id === workerId)?.turns;
          const items = turns?.[turns.length - 1]?.items;
          if (!items) return null;
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            if (item.kind === "tool_call" && item.status === "running") return { name: item.name, input: item.input };
          }
          return null;
        };
        // 佔用判定用雙重標準：「角色站在這」或「正在跑的工具屬於這一站」都算——後者以事實為準，
        // 避免角色狀態被其他顯示邏輯蓋過（例如圓桌成員被固定在會議桌）或時序落差時，明明在用卻顯示沒人。
        const occupants = allVisual.filter((w) => {
          if (w.temporary) return false;
          if (w.character.station === activeStation) return true;
          const tool = runningToolOf(w.selectId);
          return tool !== null && stationForTool(tool.name, tool.input) === activeStation;
        });
        return (
          <div
            className="station-tooltip"
            style={{ transform: `translate(-50%, -100%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y}px)` }}
          >
            <strong>{STATION_LABELS[activeStation] ?? activeStation}</strong>
            <em className="station-tooltip__desc">{STATION_DESCRIPTIONS[activeStation] ?? ""}</em>
            {occupants.length === 0
              ? <small>{t("目前沒有人在使用")}</small>
              : occupants.map((w) => {
                  const tool = runningToolOf(w.selectId);
                  // 從工具輸入抽出「正在做什麼」的細節：搜尋關鍵字(query)、網址(url)、
                  // 指令(command)、檔案路徑…讓使用者直接看到「他在查什麼／跑什麼」。
                  let detail: string | null = null;
                  if (tool && tool.input && typeof tool.input === "object") {
                    const rec = tool.input as Record<string, unknown>;
                    const pick = (k: string) => (typeof rec[k] === "string" && rec[k] ? String(rec[k]) : null);
                    const raw = pick("query") ?? pick("url") ?? pick("command") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ?? pick("prompt");
                    if (raw) detail = raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
                  }
                  return (
                    <button key={w.id} type="button" className="station-tooltip__occupant" onClick={() => onOpenLog?.(w.selectId)} title={t("點擊開啟工作日誌")}>
                      {w.name}{tool ? <span> ⚙ {tool.name}</span> : null}
                      {detail && <i className="station-tooltip__detail">{detail}</i>}
                    </button>
                  );
                })}
            {pinnedStation === activeStation && occupants.length > 0 && <small className="station-tooltip__hint">{t("點名字可開工作日誌")}</small>}
          </div>
        );
      })()}
    </>
  );
}
