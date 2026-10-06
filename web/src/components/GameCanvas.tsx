import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ApprovalDecision, ApprovalItem, CollaborationTask, Department, DepartmentMission, ToolCallItem, WorkerState } from "../types";
import type { FurnitureScreenPos, PersonScreenPos, SceneHandle, SceneView } from "../game/scene";
import type { QueueNotesTap } from "../game/personalDesks";
import { apiRequest } from "../api";
import { SHIRT_COLORS } from "../game/crewLook";
import { chooseBubblePlacement, type BubbleRect } from "../game/bubbleLayout";
import { crowdedView, declutterNameplates, nameplateVisible, type NameplateBox } from "../game/nameplateLod";
import { bossRoomWorkers } from "../game/bossRoomFilter";
import { missionCharacter } from "../game/missionScene";
import { FURNITURE_DEFS, stationPlateBoxes, tagTopClearOfPlates } from "../game/furnitureDefs";
import { roomName } from "../workspace";
import { milestoneLevel } from "../milestones";
import { stationForTool, type StationKey } from "../stations";
import { STATION_THEME } from "../stationTheme";
import { parseMcpToolName } from "../mcpToolName";
import { computeCtxGauge, SWAP_THRESHOLD_TOKENS } from "../ctxGauge";
import { stripMarkdown } from "../speechText";
import { friendlyToolSpeech } from "../workerState";
import { t, tc } from "../i18n";
import { clearViewRect, edgeMarkers, isOffscreen, nameInitials, rectCenter, type EdgeMarker, type Pt, type Rect, type SceneCameraControls } from "../game/cameraFocus";
import { lastDoneLine } from "../lastDone";

// 「一眼看出在幹嘛」活動徽章：依當前工具所屬站點給一個線性圖示＋短動詞，整合進名牌內
// （只在工作中出現、閒置收起）。圖示吃站點主題色做色彩編碼，加速一眼辨識。
const ACTIVITY_CHIP: Partial<Record<StationKey, { icon: IconName; label: string }>> = {
  terminal: { icon: "gear", label: "執行指令" },
  code: { icon: "code", label: "寫程式" },
  web: { icon: "globe", label: "上網查" },
  books: { icon: "file", label: "查資料" },
  check: { icon: "check", label: "驗證中" },
  board: { icon: "board", label: "整理任務" },
  meeting: { icon: "speech", label: "討論中" },
  desk: { icon: "gear", label: "工作中" },
};
import { NpcRadialMenu } from "./NpcRadialMenu";
import { WebShotImg } from "./WebShotImg";
import { Icon, type IconName } from "./Icon";

const STATION_LABELS: Record<string, string> = Object.fromEntries(
  FURNITURE_DEFS.filter((def) => def.label).map((def) => [def.key, def.label]),
);

/** 其他工具 has no STATION_THEME entry; same fallback accent as its counter device (furniture.ts). */
const STATION_DEFAULT_ACCENT = "#8fb6ff";

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
  /** 老闆交辦臨時部門的 NPC（ephemeralKind="dedicated"）——場景把整個部門圈進獨立房間。 */
  ephemeral: boolean;
  /** 部門任務「當前步驟」的負責人——桌位亮值勤指標，回答「現在到誰了」。 */
  onDuty: boolean;
  waiting: boolean;
  provider: WorkerState["provider"];
  model: string | null;
  role: string | null;
  workspacePath: string;
  departmentKey: string;
  workspaceLabel: string;
  collaborationPhase: "reviewing" | "returning" | "planning" | "executing" | "mission_review" | "mission_consult" | "needs_attention" | null;
  collaborationRole: "source" | "target" | null;
  /** The other end of the running collaboration — the scene draws a link beam between them. */
  collaborationPartnerId: string | null;
  /** Sub-agents only: who summoned them (portal + summon beam start there). */
  parentId?: string;
  missionProgress: { completed: number; total: number } | null;
};

// Zoom is now continuous (not stepped to integers), so the readout needs a
// decimal — but whole numbers (the common auto-fit case) should still read
// as "4x" rather than "4.0x".
/**
 * Shown on the canvas host while the office scene module downloads and Pixi
 * boots: the same dark two-tone floor tiles the office uses, so the swap to the
 * real canvas is seamless (the host's size is CSS-driven — no layout jump).
 */
const SCENE_PLACEHOLDER: CSSProperties = {
  backgroundColor: "#0e1526",
  backgroundImage: [
    "linear-gradient(45deg, #111a2e 25%, transparent 25%, transparent 75%, #111a2e 75%)",
    "linear-gradient(45deg, #111a2e 25%, transparent 25%, transparent 75%, #111a2e 75%)",
  ].join(", "),
  backgroundSize: "64px 64px",
  backgroundPosition: "0 0, 32px 32px",
};

function formatZoom(scale: number): string {
  const rounded = Math.round(scale * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

/** Scene-side extras derived from data GameCanvas already has (no new props from App). */
function withSceneExtras(list: VisualWorker[], workers: WorkerState[], thresholdTokens: number | undefined): Array<VisualWorker & { ctxPct: number | null }> {
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  const pctById = new Map<string, number | null>();
  return list.map((w) => {
    if (w.temporary) return { ...w, ctxPct: null };
    if (!pctById.has(w.selectId)) {
      const full = byId.get(w.selectId);
      const series = full ? full.turns.map((turn) => turn.contextTokens).filter((n): n is number => typeof n === "number") : [];
      pctById.set(w.selectId, computeCtxGauge(series, thresholdTokens)?.pct ?? null);
    }
    return { ...w, ctxPct: pctById.get(w.selectId) ?? null };
  });
}

function pendingApprovalFor(worker: WorkerState): ApprovalItem | null {
  const last = worker.turns[worker.turns.length - 1];
  return last?.items.find((item): item is ApprovalItem => item.kind === "approval" && item.status === "pending") ?? null;
}

// 未回答的「循環問你」：自動循環停下時標成 autopilotAsk 的通知回合會是末尾那筆——owner 一旦發話
// 就會再疊上新回合，所以「最後一筆仍是 ask」即等於還沒回。用來把這位 NPC 算進分流條的「需要你」。
function unansweredAutopilotAsk(worker: WorkerState): boolean {
  return worker.turns[worker.turns.length - 1]?.autopilotAsk === true;
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

// scene.ts 接上鏡頭導引前，這些方法不存在——一律用 optional 呼叫，接線前什麼都不做、也不會壞。
type CameraScene = SceneHandle & Partial<SceneCameraControls>;
function cameraOf(scene: SceneHandle | null): CameraScene | null {
  return scene as CameraScene | null;
}

// 會蓋在 canvas 上的面板：鏡頭置中與畫面外判定都只算「沒被蓋住的那塊」。
const CAMERA_OBSTACLES = ".crew-rail:not(.crew-rail--sheet), .holo-panel:not(.holo-panel--closed):not(.holo-panel--focus), .top-bar, .crew-strip-wrap";
// 邊緣指示不要壓在左下角的縮放列／分流條上。
const CAMERA_KEEPOUTS = ".npc-aggbar, .canvas-zoom";

/** 元素的版面位置（扣掉 transform 位移）：任務日誌開場是滑進來的，動畫途中量也要量到終點。 */
function layoutRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const transform = typeof getComputedStyle === "function" ? getComputedStyle(el).transform : "none";
  if (!transform || transform === "none" || typeof DOMMatrixReadOnly === "undefined") return r;
  const m = new DOMMatrixReadOnly(transform);
  return new DOMRect(r.left - m.m41, r.top - m.m42, r.width, r.height);
}

function hostLocal(r: DOMRect, bounds: DOMRect): Rect {
  return { left: r.left - bounds.left, top: r.top - bounds.top, right: r.right - bounds.left, bottom: r.bottom - bounds.top };
}

/** canvas 上真正看得到的區域（host 座標）。 */
function measureClearRect(host: HTMLElement): Rect {
  const bounds = host.getBoundingClientRect();
  const view: Rect = { left: 0, top: 0, right: bounds.width, bottom: bounds.height };
  if (typeof document === "undefined") return view;
  const obstacles = [...document.querySelectorAll(CAMERA_OBSTACLES)].map((el) => hostLocal(layoutRect(el), bounds));
  return clearViewRect(view, obstacles);
}

function measureKeepouts(host: HTMLElement): Rect[] {
  if (typeof document === "undefined") return [];
  const bounds = host.getBoundingClientRect();
  return [...document.querySelectorAll(CAMERA_KEEPOUTS)].map((el) => hostLocal(el.getBoundingClientRect(), bounds));
}

function placeEdgeMarker(el: HTMLElement, marker: EdgeMarker, bounds: { left: number; top: number }): void {
  el.style.transform = `translate(-50%, -50%) translate(${Math.round(bounds.left + marker.x)}px, ${Math.round(bounds.top + marker.y)}px)`;
  el.style.setProperty("--edge-angle", `${marker.angle.toFixed(3)}rad`);
}

// 穩定的空集合預設值：避免每次 render 都 new Set() 造成參照改變、白白觸發下游重算。
const EMPTY_ROUNDTABLE_IDS: ReadonlySet<string> = new Set();

// 名牌頂端：平常在腳下；作戰室後排坐在桌後，名牌改放頭上，免得蓋住同 x 前排的頭。
function nameplateTop(pos: { y: number; scale: number; tagAbove?: boolean }, plateHeight: number): number {
  return pos.tagAbove ? pos.y - plateHeight - 2 * pos.scale : pos.y + 22 * pos.scale;
}

function visualWorkers(workers: WorkerState[], activeId: string | null, collaborations: CollaborationTask[], missions: DepartmentMission[], departments: Department[] = [], roundtableIds: ReadonlySet<string> = EMPTY_ROUNDTABLE_IDS, bossRoom = false, bossTaskDepartmentIds?: ReadonlySet<string>): VisualWorker[] {
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  // 兩間房：主辦公室（原本的房間）只住常駐夥伴；BOSS 交辦房住「正在做這張交辦的那群人」
  // ——dedicated 專屬部隊＋進行中交辦被路由到的既有部門（bossTaskDepartmentIds）。開著
  // BOSS 頁時場景切到交辦房，關掉就回主辦公室；交辦房沒人時退回主辦公室避免空白（bossRoomFilter.ts）。
  const roomWorkers = bossRoomWorkers(workers, bossRoom, bossTaskDepartmentIds);
  return groupWorkersByWorkspace(roomWorkers).flatMap((worker) => {
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
    // 作戰室 NPC：沿用場景既有的 thinking 姿勢＋speech 對話泡，讓使用者直接看到辯論進行中。
    // server 標為 ephemeralKind: "warroom" 的臨時 NPC 會被拉到「meeting」會議桌邊
    // 聚集；交接（handingOff）優先。站到 meeting 站點後，scene 的 standSpot 會自動
    // 把多個 NPC 錯開排在桌邊，不會重疊。
    // （舊版是比對名字開頭的 emoji 碼位——使用者改個名字就失效，而且逼得介面
    //   得把那顆 emoji 顯示出來。現在協定寫在欄位上，名字純粹是名字。）
    const isWarRoomPeer = worker.ephemeralKind === "warroom";
    const roundtabling = !handingOff && (isWarRoomPeer || (roundtableIds.has(worker.id) && worker.busy));
    // Mission 場景生命力（missionScene.ts missionCharacter）：有工具在跑但角色還停在自家桌 → 走去對應
    // 工作站；Mission 期間對話泡一律吃 mission.executionEvents 的當下活動（工具短句／最新發言），
    // 絕不顯示他自己上次私聊的舊字（Mission 走獨立 runner，worker.character.speech 整場不會更新）。
    const missionShown = !handingOff && !roundtabling
      ? missionCharacter(worker, mission, missionStep != null && missionStep.assigneeWorkerId === worker.id)
      : null;
    const parent: VisualWorker = {
      id: worker.id,
      selectId: worker.id,
      name: worker.name,
      character: handingOff ? { ...worker.character, activity: "thinking", station: "home", speech: t("LLM 交接中…") }
        : roundtabling ? { ...worker.character, activity: "thinking", station: "meeting", speech: worker.busy ? t("作戰室辯論中…") : t("作戰室") }
        : missionShown ?? worker.character,
      active: worker.id === activeId,
      colorIndex: worker.colorIndex,
      avatarId: worker.avatarId,
      avatarKind: worker.avatarKind,
      avatarPresetId: worker.avatarPresetId,
      busy: worker.busy,
      temporary: false,
      ephemeral: worker.ephemeralKind === "dedicated",
      onDuty: Boolean(missionStep && missionStep.assigneeWorkerId === worker.id && ["executing", "reviewing"].includes(mission?.status ?? "")),
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
      collaborationPartnerId: collaboration
        ? collaboration.sourceWorkerId === worker.id ? collaboration.targetWorkerId : collaboration.sourceWorkerId
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
      ephemeral: false,
      onDuty: false,
      waiting: false,
      provider: worker.provider,
      model: worker.model,
      role: null,
      workspacePath: worker.workspacePath,
      departmentKey: worker.departmentId ?? worker.workspacePath,
      workspaceLabel: worker.departmentId ? departmentById.get(worker.departmentId)?.name ?? roomName(worker.workspacePath) : roomName(worker.workspacePath),
      collaborationPhase: null,
      collaborationRole: null,
      collaborationPartnerId: null,
      parentId: worker.id,
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
  /** true＝顯示「BOSS 交辦房」（正在做這張交辦的部門）；false＝主辦公室（常駐夥伴）。 */
  bossRoom?: boolean;
  /** 進行中交辦實際在跑的部門 id：交辦房會顯示這些部門的成員（含被路由的既有部門），不只 dedicated。 */
  bossTaskDepartmentIds?: ReadonlySet<string>;
  /** server 端換腦門檻（tokens）＝CTX 量條的 100%；沒拿到 snapshot 前用預設值。 */
  swapThresholdTokens?: number;
  /** complete_swap 發出的換腦事件：learned 只在心法真的落盤時為 true。用來在名牌內誠實閃「＋1 心法」。 */
  brainSwapEvent?: { workerId: string; learned: boolean; lesson: string | null; seq: number } | null;
  /** 點擊作戰室會議桌時觸發（App 用它開作戰室模式並聚焦輸入框）。 */
  onMeetingTableClick?(): void;
  /** Tap on empty office floor — App uses it to dismiss the task log. */
  onEmptyTap?(): void;
  /** 點右下角 OUT 書架＝開成品匣。 */
  onOpenOutbox?(): void;
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
  /** 使用者在介面別處（左欄、手機頭像列、頂欄「需要你」）主動點了某位 NPC：鏡頭滑過去。seq 每次點擊遞增。 */
  focusRequest?: { id: string; seq: number } | null;
};

export function GameCanvas({
  workers, activeId, completedTurns = 0, collaborations = [], missions = [], departments = [], roundtableIds = EMPTY_ROUNDTABLE_IDS, bossRoom = false, bossTaskDepartmentIds, swapThresholdTokens, brainSwapEvent, onMeetingTableClick, onEmptyTap, onOpenOutbox, onSelect, onOpenLog, onAvatarError,
  onRename, onAvatarWorkshop, onPersonaEditor, onDepartmentMission, onRenameDepartment, onRoomSwitch, onRemove, onResolveApproval, focusRequest,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const nameRefs = useRef(new Map<string, HTMLDivElement>());
  // Nameplates squeezed by a neighbour (role hidden); kept here so a React re-render doesn't drop the class for a frame.
  const tightIdsRef = useRef(new Set<string>());
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
  // The office scene (Pixi + all of game/*) is its own chunk, loaded on demand.
  const [sceneReady, setSceneReady] = useState(false);
  const [view, setView] = useState<SceneView | null>(null);
  // 點桌上的便利貼（排隊中的指令）→ 浮一張小卡列出前三則；點別處或 Esc 收起。
  const [notesCard, setNotesCard] = useState<QueueNotesTap | null>(null);
  const [furniturePositions, setFurniturePositions] = useState<Map<StationKey, FurnitureScreenPos>>(new Map());
  // Same positions, readable from the per-frame callback (tags step below the station plates).
  const furniturePosRef = useRef<Map<StationKey, FurnitureScreenPos>>(new Map());
  const [hoveredStation, setHoveredStation] = useState<StationKey | null>(null);
  const [pinnedStation, setPinnedStation] = useState<StationKey | null>(null);
  // Station tooltip height, measured after layout, so a tall one (several
  // occupants) slides down to stay inside the canvas instead of under the top bar.
  const stationTipRef = useRef<HTMLDivElement | null>(null);
  const [stationTipH, setStationTipH] = useState(0);
  useLayoutEffect(() => {
    const h = stationTipRef.current?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - stationTipH) > 1) setStationTipH(h);
  });
  // 場景 callbacks 只在掛載時建一次，用 ref 拿最新的 onMeetingTableClick，避免閉包吃到舊值。
  const meetingClickRef = useRef(onMeetingTableClick);
  meetingClickRef.current = onMeetingTableClick;
  const emptyTapRef = useRef(onEmptyTap);
  emptyTapRef.current = onEmptyTap;
  const openOutboxRef = useRef(onOpenOutbox);
  openOutboxRef.current = onOpenOutbox;
  // 工作小窗多行歷史：speech 每次變化就進每人滾動緩衝（收工清空）；終端機小窗用它演出像真 shell 的最近幾條指令。
  // 每行帶時間戳；cmds＝本回合累計指令數（標題列顯示）。
  const speechLogRef = useRef(new Map<string, { last: string; lines: Array<{ text: string; at: number }>; cmds: number }>());
  // 吃「畫面上實際顯示」的角色狀態（visualWorkers）：Mission NPC 的 speech 來自 mission.executionEvents，
  // 直接讀 worker.character 會把他自己上次私聊的舊字灌進工作小窗。
  useEffect(() => {
    const shownById = new Map(
      visualWorkers(workers, activeId, collaborations, missions, departments, roundtableIds, bossRoom, bossTaskDepartmentIds)
        .filter((v) => !v.temporary)
        .map((v) => [v.id, v.character] as const),
    );
    for (const w of workers) {
      const log = speechLogRef.current.get(w.id) ?? { last: "", lines: [], cmds: 0 };
      speechLogRef.current.set(w.id, log);
      if (!w.busy) { log.last = ""; log.lines.length = 0; log.cmds = 0; continue; }
      const shown = shownById.get(w.id) ?? w.character;
      const sp = stripMarkdown(shown.speech);
      if (sp && sp !== log.last) {
        log.last = sp;
        // 時間戳用 server 蓋章的事件時間（speechAt），不用 render 當下——重整/重連重播歷史時才不會全變成「現在」
        log.lines.push({ text: sp, at: shown.speechAt ?? Date.now() });
        if (/^執行指令[:：]/.test(sp)) log.cmds += 1;
        if (log.lines.length > 7) log.lines.shift();
      }
    }
  }, [workers, missions, collaborations, activeId, departments, roundtableIds, bossRoom, bossTaskDepartmentIds]);

  // ── 脈絡公事包：把 token 負載畫成名牌內的手提箱（填充＝佔用），換腦（context 驟降）時播一次「瘦身」脈動。
  // 純前端、只吃既有 ctxGauge 數據；不動後端與換腦邏輯。整合進名牌實體，刻意不做頭上飄浮卡。
  const ctxPrevCurrentRef = useRef(new Map<string, number>());
  const [swapFlashIds, setSwapFlashIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  useEffect(() => {
    const swapped: string[] = [];
    for (const w of workers) {
      const series = w.turns.map((turn) => turn.contextTokens).filter((n): n is number => typeof n === "number");
      const gauge = computeCtxGauge(series, swapThresholdTokens);
      if (!gauge) continue;
      const prev = ctxPrevCurrentRef.current.get(w.id);
      // current 從高位驟降三成以上＝發生換腦／compact，context 被壓縮重置到新底盤
      if (prev != null && gauge.currentTokens < prev * 0.7) {
        swapped.push(w.id);
        sceneRef.current?.brainReset(w.id); // halo over the NPC's head (scene debounces repeats)
      }
      ctxPrevCurrentRef.current.set(w.id, gauge.currentTokens);
    }
    if (swapped.length === 0) return;
    setSwapFlashIds((prev) => { const next = new Set(prev); for (const id of swapped) next.add(id); return next; });
    // 脈動演完就移除；不綁 effect cleanup，避免 workers 每次更新就把計時器清掉導致脈動卡住不消。
    setTimeout(() => {
      setSwapFlashIds((prev) => { const next = new Set(prev); for (const id of swapped) next.delete(id); return next; });
    }, 1500);
  }, [workers, swapThresholdTokens]);

  // 「學到心法」誠實閃現：只吃後端 complete_swap 事件、且 learned（心法真的落盤）才閃「＋1 心法」。
  // 被去重擋下或走活命分支時 learned=false → 不閃（畫面只會有上面那個中性的壓縮脈動）。
  const [learnedFlash, setLearnedFlash] = useState<{ id: string; lesson: string | null } | null>(null);
  const lastSwapSeqRef = useRef(0);
  useEffect(() => {
    if (!brainSwapEvent || brainSwapEvent.seq === lastSwapSeqRef.current) return;
    lastSwapSeqRef.current = brainSwapEvent.seq;
    // The halo is neutral ("context reset"), so it plays whether or not a lesson was learned.
    sceneRef.current?.brainReset(brainSwapEvent.workerId);
    if (!brainSwapEvent.learned) return; // 誠實門檻：沒真的學到就不宣稱學到
    const id = brainSwapEvent.workerId;
    const lesson = brainSwapEvent.lesson;
    setLearnedFlash({ id, lesson });
    setTimeout(() => setLearnedFlash((cur) => (cur && cur.id === id ? null : cur)), 4200);
  }, [brainSwapEvent]);

  // Wall-clock start time per busy worker, purely for the "已執行 Ns" live
  // readout — not persisted, just a local ticking display.
  const turnStartRef = useRef(new Map<string, number>());
  const [, forceTick] = useState(0);
  const sceneRef = useRef<SceneHandle | null>(null);
  const screenPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  // The scene's hover, readable from the per-frame positions callback (nameplate declutter).
  const hoveredIdRef = useRef<string | null>(null);
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
  const swapThresholdRef = useRef(swapThresholdTokens);
  swapThresholdRef.current = swapThresholdTokens;
  const latestBossRoom = useRef(bossRoom);
  latestBossRoom.current = bossRoom;
  const latestBossTaskDepartmentIds = useRef(bossTaskDepartmentIds);
  latestBossTaskDepartmentIds.current = bossTaskDepartmentIds;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const milestoneRef = useRef(0);
  milestoneRef.current = milestoneLevel(completedTurns);
  const onAvatarErrorRef = useRef(onAvatarError);
  onAvatarErrorRef.current = onAvatarError;
  const onDepartmentMissionRef = useRef(onDepartmentMission);
  onDepartmentMissionRef.current = onDepartmentMission;

  // ── 鏡頭導引（game/cameraFocus.ts；scene 端接線見 SceneCameraControls）──
  // 跟拍：scene 是唯一事實來源（拖曳／恢復視角／NPC 離場都會結束），每幀同步回來。
  const [followingId, setFollowingId] = useState<string | null>(null);
  const followingRef = useRef<string | null>(null);
  // Alt+點擊＝戳人：Alt 連點兩下不能被當成「雙擊跟拍」。
  const altPressRef = useRef(false);
  // 主動點名後，選取環在 NPC 腳下亮一下。
  const [focusPulse, setFocusPulse] = useState<{ id: string; seq: number } | null>(null);
  const focusPulseRef = useRef<{ id: string; seq: number } | null>(null);
  focusPulseRef.current = focusPulse;
  const focusRingRef = useRef<HTMLDivElement | null>(null);
  // 畫面外的「需要你」NPC：邊緣指示。
  const needIdsRef = useRef<ReadonlySet<string>>(new Set());
  const offscreenRef = useRef<ReadonlySet<string>>(new Set());
  const [offscreenNeed, setOffscreenNeed] = useState<string[]>([]);
  const edgeMarkerRefs = useRef(new Map<string, HTMLButtonElement>());
  const edgeMarkerPosRef = useRef(new Map<string, EdgeMarker>());
  const clearRectRef = useRef<{ rect: Rect; keepouts: Rect[]; at: number } | null>(null);

  const cameraAnchor = (): Pt | undefined => {
    const host = hostRef.current;
    return host ? rectCenter(measureClearRect(host)) : undefined;
  };
  const focusOnNpc = (id: string) => {
    cameraOf(sceneRef.current)?.focusOn?.(id, cameraAnchor());
    setFocusPulse((current) => ({ id, seq: (current?.seq ?? 0) + 1 }));
  };
  const followNpc = (id: string) => {
    const scene = cameraOf(sceneRef.current);
    if (!scene?.follow) return;
    scene.follow(id, cameraAnchor());
    followingRef.current = id;
    setFollowingId(id);
  };
  const stopFollowing = () => {
    cameraOf(sceneRef.current)?.stopFollow?.();
    followingRef.current = null;
    setFollowingId(null);
  };
  const followNpcRef = useRef(followNpc);
  followNpcRef.current = followNpc;

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
    const notePointerAlt = (event: PointerEvent) => { altPressRef.current = event.altKey; };
    host.addEventListener("pointerdown", notePointerAlt, true);

    // 每幀：跟拍狀態同步、選取環跟著 NPC、畫面外「需要你」的邊緣指示。
    function updateCameraOverlays(positions: PersonScreenPos[], bounds: DOMRect): void {
      const scene = cameraOf(sceneRef.current);
      const following = scene?.followingId?.() ?? null;
      if (following !== followingRef.current) {
        followingRef.current = following;
        setFollowingId(following);
      }
      const pulse = focusPulseRef.current;
      const ring = focusRingRef.current;
      if (pulse && ring) {
        const pos = positions.find((candidate) => candidate.id === pulse.id);
        if (pos) {
          ring.style.transform = `translate(-50%, -50%) translate(${bounds.left + pos.x}px, ${bounds.top + pos.y + 17 * pos.scale}px)`;
          ring.style.setProperty("--ring-w", `${Math.round(20 * pos.scale)}px`);
        }
      }
      const now = performance.now();
      const host = hostRef.current;
      if (host && (!clearRectRef.current || now - clearRectRef.current.at > 250)) {
        clearRectRef.current = { rect: measureClearRect(host), keepouts: measureKeepouts(host), at: now };
      }
      const clear = clearRectRef.current;
      const need = needIdsRef.current;
      if (!clear || need.size === 0) {
        if (offscreenRef.current.size > 0) {
          offscreenRef.current = new Set();
          setOffscreenNeed([]);
        }
        return;
      }
      const wasOff = offscreenRef.current;
      const nextOff = new Set<string>();
      const points: Array<{ id: string; x: number; y: number }> = [];
      for (const pos of positions) {
        if (!need.has(pos.id) || pos.opacity <= 0.05) continue;
        const point = { x: pos.x, y: pos.y + 8 * pos.scale };
        if (isOffscreen(point, clear.rect, wasOff.has(pos.id))) {
          nextOff.add(pos.id);
          points.push({ id: pos.id, ...point });
        }
      }
      for (const marker of edgeMarkers(points, clear.rect, { keepouts: clear.keepouts })) {
        edgeMarkerPosRef.current.set(marker.id, marker);
        const el = edgeMarkerRefs.current.get(marker.id);
        if (el) placeEdgeMarker(el, marker, bounds);
      }
      if (nextOff.size !== wasOff.size || [...nextOff].some((id) => !wasOff.has(id))) {
        offscreenRef.current = nextOff;
        setOffscreenNeed([...nextOff]);
      }
    }

    // Loaded on demand so the office engine stays out of the app's entry bundle.
    // fxBus events emitted before it arrives simply have no listener yet.
    import("../game/scene").then(({ createScene }) => createScene(host, {
      onPositions: (positions) => {
        const bounds = host.getBoundingClientRect();
        screenPositionsRef.current = new Map(positions.map((position) => [position.id, { x: position.x, y: position.y }]));
        // Someone working at the counter has their tag land on the station's
        // name plate; such tags start just below the plate instead.
        const plates = positions.length > 0 ? stationPlateBoxes(furniturePosRef.current.values(), positions[0].scale) : [];
        const tagTop = (pos: (typeof positions)[number], height: number, width: number) =>
          tagTopClearOfPlates(pos.x, nameplateTop(pos, height), width, height, plates);
        // Crowded + zoomed out: keep only tags that don't collide (most important first).
        const crowded = positions.length > 0 && crowdedView(positions[0].scale, positions.length);
        let keep: Set<string> | null = null;
        if (crowded) {
          const boxes: NameplateBox[] = [];
          for (const pos of positions) {
            const plate = nameRefs.current.get(pos.id);
            if (!plate) continue;
            const active = plate.classList.contains("npc-nameplate--active");
            const busy = plate.classList.contains("npc-nameplate--busy");
            const hovered = pos.id === hoveredIdRef.current;
            if (!active && !busy && !hovered) continue;
            boxes.push({
              id: pos.id,
              x: pos.x,
              top: tagTop(pos, plate.offsetHeight || 18, plate.offsetWidth || 80),
              width: plate.offsetWidth || 80,
              height: plate.offsetHeight || 18,
              priority: active ? 3 : hovered ? 2 : 1,
            });
          }
          keep = declutterNameplates(boxes);
        } else if (positions.length > 1) {
          // Roomy view: neighbours whose full tags (name + role) would touch drop the role instead.
          // Widths are taken with the role showing (cached while tight) so the check can't flip-flop.
          const wide = positions.map((pos) => {
            const plate = nameRefs.current.get(pos.id);
            if (!plate) return null;
            if (!plate.classList.contains("npc-nameplate--tight")) {
              plate.dataset.fullw = String(plate.offsetWidth);
              // 閒置名牌第二行（X 分前完成）收合時高度會變矮——高度也用展開時的，避免收／展來回跳。
              plate.dataset.fullh = String(plate.offsetHeight);
            }
            const h = Number(plate.dataset.fullh) || plate.offsetHeight || 18;
            return { id: pos.id, plate, x: pos.x, top: tagTop(pos, h, plate.offsetWidth || 80), w: Number(plate.dataset.fullw) || plate.offsetWidth, h };
          });
          for (let i = 0; i < wide.length; i++) {
            const a = wide[i];
            if (!a) continue;
            let tight = false;
            for (let j = 0; j < wide.length && !tight; j++) {
              const b = wide[j];
              if (!b || i === j) continue;
              tight = Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 4 && Math.abs(a.top - b.top) < (a.h + b.h) / 2;
            }
            a.plate.classList.toggle("npc-nameplate--tight", tight);
            if (tight) tightIdsRef.current.add(a.id);
            else tightIdsRef.current.delete(a.id);
          }
          // Dropping the role isn't always enough (side-by-side busy tags at shared desks):
          // tags that still collide yield to the more important one; hover brings any back.
          const boxes: NameplateBox[] = [];
          for (const a of wide) {
            if (!a) continue;
            const active = a.plate.classList.contains("npc-nameplate--active");
            const hovered = a.id === hoveredIdRef.current;
            const busy = a.plate.classList.contains("npc-nameplate--busy");
            boxes.push({ id: a.id, x: a.x, top: a.top, width: a.plate.offsetWidth || a.w, height: a.h, priority: active ? 3 : hovered ? 2 : busy ? 1 : 0 });
          }
          keep = declutterNameplates(boxes);
        }
        for (const pos of positions) {
          const nameplate = nameRefs.current.get(pos.id);
          if (nameplate) {
            // Below the sprite's feet (pos.y is 17 art px above them, feet sit
            // 19 below pos.y at head-top anchor) — keeps the desk, monitor and
            // department sign above the head completely clear of DOM chrome.
            nameplate.style.transform = `translate(-50%, 0) translate(${bounds.left + pos.x}px, ${bounds.top + tagTop(pos, nameplate.offsetHeight || 18, nameplate.offsetWidth || 80)}px)`;
            // Big crew zoomed out: idle tags step back (busy / selected / hovered stay).
            const show = nameplateVisible({
              x: pos.x,
              y: pos.y,
              viewWidth: bounds.width,
              viewHeight: bounds.height,
              scale: pos.scale,
              crowd: positions.length,
              important: pos.id === hoveredIdRef.current ||
                nameplate.classList.contains("npc-nameplate--active") ||
                nameplate.classList.contains("npc-nameplate--busy"),
            });
            const visible = show && (!keep || keep.has(pos.id));
            nameplate.style.opacity = visible ? String(pos.opacity) : "0";
            nameplate.style.visibility = visible ? "" : "hidden";
          }
          const identity = identityRefs.current.get(pos.id);
          if (identity) {
            // Beside the sprite instead of on top of it; flip to the left
            // when the NPC stands near the right edge of the canvas.
            // The card now carries the live work view, so it can be tall: keep it inside the canvas vertically too.
            const sideGap = Math.round(14 + pos.scale * 4);
            const cardW = identity.offsetWidth || 230;
            const cardH = identity.offsetHeight || 120;
            const flip = pos.x + cardW + sideGap > bounds.width;
            const x = flip ? pos.x - sideGap - cardW : pos.x + sideGap;
            const y = Math.max(8, Math.min(bounds.height - cardH - 8, pos.y - cardH * 0.25));
            identity.style.transform = `translate(${bounds.left + x}px, ${bounds.top + y}px)`;
            identity.dataset.side = flip ? "left" : "right";
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
        updateCameraOverlays(positions, bounds);
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
        // 雙擊 NPC＝跟拍（Alt 連點是戳人，不算）。
        if (!altPressRef.current) followNpcRef.current(id);
      },
      onHover: (id) => {
        hoveredIdRef.current = id;
        setHoveredId(id);
      },
      onAvatarError: (id, message) => onAvatarErrorRef.current?.(id, message),
      onFurniturePositions: (list) => {
        const map = new Map(list.map((pos) => [pos.key, pos]));
        furniturePosRef.current = map;
        setFurniturePositions(map);
      },
      onFurnitureHover: setHoveredStation,
      onFurnitureClick: (key) => {
        setPinnedStation((current) => (current === key ? null : key));
        if (key === "meeting") meetingClickRef.current?.(); // 點會議桌＝開作戰室模式
      },
      onOutboxClick: () => openOutboxRef.current?.(),
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
      // 平移（拖曳、鏡頭滑動、跟拍）每幀都會回報；縮放列只關心這四個值，沒變就不重畫整個覆蓋層。
      onQueueNotes: (tap) => setNotesCard(tap),
      onViewChange: (next) => setView((current) => (
        current && current.scale === next.scale && current.minScale === next.minScale &&
        current.maxScale === next.maxScale && current.isDefault === next.isDefault ? current : next
      )),
    })).then((h) => {
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
      setSceneReady(true);
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
      sceneRef.current?.setWorkers(withSceneExtras(visualWorkers(latest.current.workers, latest.current.activeId, latestCollaborations.current, latestMissions.current, latestDepartments.current, EMPTY_ROUNDTABLE_IDS, latestBossRoom.current, latestBossTaskDepartmentIds.current), latest.current.workers, swapThresholdRef.current));
    }

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      host.removeEventListener("pointerdown", notePointerAlt, true);
      handle?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    latest.current = { workers, activeId };
    sceneRef.current?.setWorkers(withSceneExtras(visualWorkers(workers, activeId, collaborations, missions, departments, roundtableIds, bossRoom, bossTaskDepartmentIds), workers, swapThresholdTokens));
  }, [workers, activeId, collaborations, missions, departments, roundtableIds, bossRoom, bossTaskDepartmentIds, swapThresholdTokens]);


  useEffect(() => {
    sceneRef.current?.setMilestone(milestoneLevel(completedTurns));
  }, [completedTurns]);

  // 桌上便利貼＝每位的排隊指令。
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const worker of workers) scene.setQueue(worker.id, (worker.queue ?? []).map((item) => item.message));
  }, [workers, sceneReady]);

  // 白板正字（今日完成）與紙簍紙團（各人今日失敗）：吃 /api/day-report，回合數變了才重抓（2 秒防抖）。
  useEffect(() => {
    if (!sceneReady) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      apiRequest<{ totals: { turns: number; errors: number }; workers: Array<{ workerId: string; errors: number }> }>("/api/day-report")
        .then((report) => {
          const scene = sceneRef.current;
          if (cancelled || !scene) return;
          scene.setTodayDone(Math.max(0, report.totals.turns - report.totals.errors));
          scene.setTodayFailures(new Map(report.workers.map((stat) => [stat.workerId, stat.errors])));
        })
        .catch(() => { /* 只是裝飾，抓不到就維持原樣 */ });
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [completedTurns, sceneReady]);

  useEffect(() => {
    if (!notesCard) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest(".queue-notes-card")) return;
      setNotesCard(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", close, true);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", close, true);
    };
  }, [notesCard]);

  // 介面別處主動點名（左欄／手機頭像列／頂欄「需要你」）→ 鏡頭滑過去。掛載時的舊請求不重播。
  const lastFocusSeqRef = useRef(focusRequest?.seq ?? 0);
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === lastFocusSeqRef.current) return;
    lastFocusSeqRef.current = focusRequest.seq;
    focusOnNpc(focusRequest.id);
  }, [focusRequest]);

  // 選取環只亮一下就收。
  useEffect(() => {
    if (!focusPulse) return;
    const timer = setTimeout(() => setFocusPulse((current) => (current?.seq === focusPulse.seq ? null : current)), 1200);
    return () => clearTimeout(timer);
  }, [focusPulse]);

  // 跟拍中按 Esc 結束（不吞掉這個鍵：其他層照常收到）。
  useEffect(() => {
    if (!followingId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) stopFollowing();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [followingId]);

  // 閒置名牌「X 分前完成」：每 30 秒重畫一次就夠（忙碌時另有每秒的計時）。
  useEffect(() => {
    if (!workers.some((worker) => !worker.busy && worker.turns.length > 0)) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [workers]);

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
      // The pinned tooltip's own occupant buttons must stay clickable.
      if (event.target instanceof Element && event.target.closest(".station-tooltip")) return;
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

  // 必須與上方 setWorkers 用同一組參數（含 bossRoom 過濾）——否則 BOSS 房裡場景精靈與
  // DOM 覆蓋層（名牌/泡泡/工作視窗）取到不同的 worker 集合，兩邊對不上。
  const allVisual = visualWorkers(workers, activeId, collaborations, missions, departments, roundtableIds, bossRoom, bossTaskDepartmentIds);
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));

  // 彙總分流條：畫面上的隊員（排除子代理）一眼看「幾個在忙／幾個需要你／幾個待命」；
  // 「需要你」可點，一鍵選取＋開第一個等你核准的 NPC 日誌（全域信號，補名牌徽章的個別視角）。
  const aggVisual = allVisual.filter((w) => !w.temporary);
  const needIds = aggVisual
    .map((w) => w.selectId)
    .filter((id) => { const full = workersById.get(id); return !!full && (!!pendingApprovalFor(full) || unansweredAutopilotAsk(full)); });
  needIdsRef.current = new Set(needIds);
  const aggBusy = aggVisual.filter((w) => w.busy).length;
  const aggIdle = aggVisual.length - aggBusy;

  return (
    <>
      <div className="game-host" ref={hostRef} style={sceneReady ? undefined : SCENE_PLACEHOLDER} />
      {aggVisual.length > 0 && (
        <div className="npc-aggbar" role="group" aria-label={t("小隊狀態")}>
          <span className="npc-aggbar__seg"><Icon name="gear" size={11} />{aggBusy} {t("工作中")}</span>
          {needIds.length > 0 && (
            <button type="button" className="npc-aggbar__seg npc-aggbar__seg--need" title={t("點我跳到需要你的 NPC")}
              onClick={() => { const id = needIds[0]; if (id) { onSelect(id); onOpenLog?.(id); focusOnNpc(id); } }}>
              <Icon name="bell" size={11} />{needIds.length} {t("需要你")}
            </button>
          )}
          <span className="npc-aggbar__seg npc-aggbar__seg--idle"><Icon name="moon" size={11} />{aggIdle} {t("待命")}</span>
          {followingId && (
            <button type="button" className="npc-aggbar__seg npc-aggbar__seg--follow"
              title={t("正在跟拍 {name}；拖曳畫面、按 Esc 或點這裡結束", { name: workersById.get(followingId)?.name ?? "NPC" })}
              onClick={stopFollowing}>
              <span className="npc-aggbar__follow-dot" aria-hidden="true" />{t("跟拍中・Esc 結束")}
            </button>
          )}
        </div>
      )}
      {focusPulse && <div key={focusPulse.seq} ref={focusRingRef} className="npc-focus-ring" aria-hidden="true" />}
      {offscreenNeed.map((id) => {
        const worker = workersById.get(id);
        if (!worker) return null;
        const last = edgeMarkerPosRef.current.get(id);
        const bounds = hostRef.current?.getBoundingClientRect();
        return (
          <button
            key={id}
            type="button"
            ref={(el) => {
              if (el) edgeMarkerRefs.current.set(id, el);
              else edgeMarkerRefs.current.delete(id);
            }}
            className="npc-edge-marker"
            style={last && bounds ? {
              transform: `translate(-50%, -50%) translate(${Math.round(bounds.left + last.x)}px, ${Math.round(bounds.top + last.y)}px)`,
              "--edge-angle": `${last.angle.toFixed(3)}rad`,
            } as CSSProperties : { visibility: "hidden" }}
            aria-label={t("{name} 在畫面外等你核准，點我移過去", { name: worker.name })}
            title={t("{name} 等你核准", { name: worker.name })}
            onClick={() => focusOnNpc(id)}
          >
            <span className="npc-edge-marker__arrow" aria-hidden="true" />
            <span className="npc-edge-marker__face" aria-hidden="true">{nameInitials(worker.name)}</span>
          </button>
        );
      })}
      {notesCard && (() => {
        const bounds = hostRef.current?.getBoundingClientRect();
        if (!bounds) return null;
        return (
          <div
            className="queue-notes-card"
            role="dialog"
            aria-label={notesCard.card.title}
            style={{ left: Math.round(bounds.left + notesCard.global.x), top: Math.round(bounds.top + notesCard.global.y) }}
          >
            <strong>{notesCard.card.title}</strong>
            <ol>{notesCard.card.lines.map((line, index) => <li key={index}>{line}</li>)}</ol>
            {notesCard.card.more && <small>{notesCard.card.more}</small>}
          </div>
        );
      })()}
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
            onClick={() => { stopFollowing(); sceneRef.current?.resetView(); }}
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
      {/* Per-NPC overlays stay hidden until the scene has placed them (no pile-up at the top-left while it loads). */}
      <div style={{ display: "contents", visibility: sceneReady ? undefined : "hidden" }}>
      {allVisual.map((w) => {
        const collaboration = !w.temporary ? collaborations.find((task) => ["running", "returning"].includes(task.status) && (task.sourceWorkerId === w.id || task.targetWorkerId === w.id)) : undefined;
        const mission = !w.temporary ? missions.find((task) => ["planning", "executing", "reviewing", "needs_attention"].includes(task.status) && (task.departmentId ? task.departmentId === w.departmentKey : task.workspacePath === w.workspacePath)) : undefined;
        const missionStep = mission?.currentStepIndex == null ? null : mission.steps[mission.currentStepIndex];
        const collaboratorId = collaboration?.sourceWorkerId === w.id ? collaboration.targetWorkerId : collaboration?.sourceWorkerId;
        const collaborator = collaboratorId ? workersById.get(collaboratorId) : undefined;
        const speech = stripMarkdown(w.character.speech);
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
        // NPC 卡：只在滑鼠停留時於身旁長出一張（身分＋即時工作畫面＋統計），平常只留一行名牌＋活動徽章，辦公室保持整潔。
        // 卡開著時名牌不再重複用時／活動徽章。有站點主題的忙碌 NPC 一律不顯示 speech 泡（徽章／卡片已交代在幹嘛）。
        const winStation = w.character.station;
        const winTheme = w.busy && winStation ? STATION_THEME[winStation] : undefined;
        const winQuery = w.character.webQuery?.trim() || "";
        const cardOpen = hoveredId === w.id && !w.temporary && menuOpenFor !== w.id;
        const thinkingNow = w.character.activity === "thinking";
        // 作戰室入座的閒置成員只帶「作戰室」佔位字：那不是對話，泡泡反而蓋住後排座位的人——不顯示。
        const warRoomPlaceholder = w.character.station === "meeting" && speech === t("作戰室");
        const bubbleShown = winTheme || warRoomPlaceholder ? "" : shown;
        // 脈絡公事包數據（名牌與 hover 身分卡共用，算一次）：扣掉出生底盤後的「可用量」%。
        const full = workersById.get(w.selectId);
        const ctxSeries = full ? full.turns.map((turn) => turn.contextTokens).filter((n): n is number => typeof n === "number") : [];
        const ctxGauge = computeCtxGauge(ctxSeries, swapThresholdTokens);
        const ctxPct = ctxGauge?.pct ?? null;
        const ctxLevel = ctxPct === null ? null : ctxPct >= 85 ? "danger" : ctxPct >= 60 ? "warn" : "ok";
        const swapFlash = swapFlashIds.has(w.id);
        // 整潔優先：ctx 還低（<50%）就不顯示公事包，逼近換腦門檻才浮現並長高變紅；換腦脈動時強制顯示。
        const showCase = ctxPct !== null && (ctxPct >= 50 || swapFlash);
        // 閒置名牌第二行「12 分前・寫完 README」；忙碌時仍是活動徽章，協作／部門任務徽章在時讓位。
        const doneLine = !w.busy && !w.temporary && !collaboration && !mission && full ? lastDoneLine(full, Date.now()) : null;
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
                tightIdsRef.current.has(w.id) ? "npc-nameplate--tight" : "",
                cardOpen ? "npc-nameplate--carded" : "",
              ].join(" ")}
              style={{ borderColor: accent }}
            >
              <span className="npc-nameplate__name">{w.name}</span>
              {w.role && <span className="npc-nameplate__role">{w.role}</span>}
              {showCase && (
                <span
                  className={["npc-nameplate__case", `npc-nameplate__case--${swapFlash ? "swap" : ctxLevel}`].join(" ")}
                  title={swapFlash
                    ? t("換腦：context 已壓縮、底盤重置，交接摘要帶進新工作階段")
                    : t("脈絡公事包：context 約 {current}k／換腦門檻 {limit}k（填充＝token 負載）", { current: Math.round((ctxGauge?.currentTokens ?? 0) / 1000), limit: Math.round((swapThresholdTokens ?? SWAP_THRESHOLD_TOKENS) / 1000) })}
                >
                  <Icon name="briefcase" size={9} className="npc-nameplate__case-ico" />
                  <span className="npc-nameplate__case-track">
                    <span className="npc-nameplate__case-fill" style={{ height: `${swapFlash ? 14 : Math.max(8, ctxPct ?? 0)}%` }} />
                  </span>
                </span>
              )}
              {elapsedSec != null && !cardOpen && <span className="npc-nameplate__elapsed">{elapsedSec}s</span>}
              {collaboration && <span className="npc-nameplate__collaboration" title={collaboration.objective}>
                {collaboration.status === "returning"
                  ? t("{status} · {name}", { status: collaboration.sourceWorkerId === w.id ? t("接續完成中") : t("結果已交回"), name: collaborator?.name ?? "NPC" })
                  : t("{status} · {name}", { status: collaboration.sourceWorkerId === w.id ? t("委派中") : t("協作執行中"), name: collaborator?.name ?? "NPC" })}
              </span>}
              {mission && <span className="npc-nameplate__collaboration npc-nameplate__mission" title={mission.objective}>
                {mission.status === "planning" && mission.bossWorkerId === w.id ? t("部門工作規劃中") : missionStep?.assigneeWorkerId === w.id ? `${missionStep.kind === "review" ? "REVIEW" : missionStep.kind === "consult" ? "CONSULT" : "MISSION"} · ${missionStep.title}` : t("部門工作")}
              </span>}
              {w.busy && !collaboration && !mission && !cardOpen && (() => {
                // 一眼看出在幹嘛：思考中 vs 各站點工作，整合成名牌內一行圖示＋短動詞
                const thinking = w.character.activity === "thinking";
                const chip = thinking ? { icon: "brain" as IconName, label: t("思考中") } : (ACTIVITY_CHIP[w.character.station] ?? ACTIVITY_CHIP.desk!);
                const tint = thinking ? "#9db4d8" : (STATION_THEME[w.character.station]?.accent ?? "#8fb6ff");
                return (
                  <span className="npc-nameplate__activity" style={{ "--act": tint } as CSSProperties}>
                    <Icon name={chip.icon} size={9} className="npc-nameplate__activity-ico" />
                    <span className="npc-nameplate__activity-label">{thinking ? chip.label : tc("activity", chip.label)}</span>
                  </span>
                );
              })()}
              {doneLine && <span className="npc-nameplate__done">{doneLine}</span>}
              {learnedFlash?.id === w.id && (
                <span className="npc-nameplate__learned" title={learnedFlash.lesson ?? undefined}>
                  <Icon name="brain" size={9} className="npc-nameplate__learned-ico" />
                  <span className="npc-nameplate__learned-label">{t("＋1 心法")}</span>
                </span>
              )}
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
            {cardOpen && (() => {
              // 合一的 NPC 卡：滑鼠停留時在身旁長出一張——身分、即時工作畫面（終端機／知識庫／瀏覽器…）、統計，
              // 取代以前頭上工作窗＋身旁身分卡＋腳下名牌三塊各說各話。full / ctxGauge 已在 map 本體算過，這裡直接重用。
              const doneTurns = full?.turns.filter((turn) => turn.status !== "running").length ?? 0;
              const totalCost = full?.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0) ?? 0;
              const autoMode = full?.autoApproveMode ?? "off";
              const autoLabel = autoMode === "invincible" ? t("無限制") : autoMode === "full" ? t("完全自動") : autoMode === "safe" ? t("安全自動") : t("手動核准");
              const dept = full?.departmentId ? departments.find((candidate) => candidate.id === full.departmentId) : undefined;
              const status = !w.busy ? "idle" : thinkingNow ? "thinking" : "working";
              return (
              <div ref={(element) => {
                if (element) identityRefs.current.set(w.id, element);
                else identityRefs.current.delete(w.id);
              }}
                className={[
                  "npc-identity-card",
                  `npc-identity-card--${status}`,
                  w.character.mood === "error" ? "npc-identity-card--error" : w.character.mood === "success" ? "npc-identity-card--success" : "",
                ].join(" ")}
                style={{ "--ww-accent": winTheme?.accent ?? accent } as CSSProperties}
              >
                <div className="npc-identity-card__head">
                  <strong>{w.name}</strong>
                  <span className="npc-identity-card__status">
                    <span className="npc-identity-card__dot" />
                    {status === "working" ? t("執行中") : status === "thinking" ? t("思考中") : t("待命")}
                    {elapsedSec != null && <span className="npc-identity-card__elapsed">{elapsedSec}s</span>}
                  </span>
                </div>
                {w.role && <small className="npc-identity-card__role">{w.role}</small>}
                {winTheme && (
                  <div className={`npc-workwindow npc-workwindow--${winTheme.kind}`}>
                    <div className="npc-workwindow__bar">
                      <span className="npc-workwindow__title">
                        <Icon name={(ACTIVITY_CHIP[winStation] ?? ACTIVITY_CHIP.desk!).icon} size={10} className="npc-workwindow__title-ico" />
                        {winTheme.label}
                      </span>
                      {winTheme.kind === "term" && (speechLogRef.current.get(w.id)?.cmds ?? 0) > 0 && (
                        <span className="npc-workwindow__meta">{speechLogRef.current.get(w.id)!.cmds} cmd</span>
                      )}
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
                          const src = raw.length ? raw : [{ text: stripMarkdown(w.character.speech) || t("執行中…"), at: w.character.speechAt ?? Date.now() }];
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
                          const shownRows = rows.slice(-4);
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
                      // key 綁內容：換一份文件／一個新動作時重新掛載，播一次翻頁亮光。
                      <div key={(stripMarkdown(w.character.speech) || "").slice(0, 90)} className="npc-workwindow__body npc-workwindow__body--flip">
                        {winTheme.kind === "check" ? <Icon name="check" size={11} className="npc-workwindow__body-ico" /> : winTheme.kind === "docs" ? <Icon name="file" size={11} className="npc-workwindow__body-ico" /> : winTheme.kind === "board" ? "• " : ""}
                        {(stripMarkdown(w.character.speech) || t("執行中…")).slice(0, 90)}
                      </div>
                    )}
                  </div>
                )}
                <small>{w.provider === "claude" ? "Claude Code" : "Codex"} · {w.model || t("預設模型")}</small>
                <small>{dept ? `${dept.name} · ` : ""}{roomName(w.workspacePath)}</small>
                <div className="npc-identity-card__stats">
                  <span className="npc-identity-card__stat">{t("完成 {count}", { count: doneTurns })}</span>
                  {totalCost > 0 && <span className="npc-identity-card__stat">${totalCost < 1 ? totalCost.toFixed(3) : totalCost.toFixed(2)}</span>}
                  <span className={`npc-identity-card__stat npc-identity-card__auto npc-identity-card__auto--${autoMode}`}>{autoLabel}</span>
                </div>
                {ctxPct !== null && (
                  <div className={`npc-identity-card__ctx npc-identity-card__ctx--${ctxLevel}`} title={t("context 約 {current}k（底盤 {baseline}k 不計）；條滿 = 換腦門檻 {limit}k", { current: Math.round((ctxGauge?.currentTokens ?? 0) / 1000), baseline: Math.round((ctxGauge?.baselineTokens ?? 0) / 1000), limit: Math.round((swapThresholdTokens ?? SWAP_THRESHOLD_TOKENS) / 1000) })}>
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
      </div>
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
        const accent = STATION_THEME[activeStation]?.accent ?? STATION_DEFAULT_ACCENT;
        const pinned = pinnedStation === activeStation;
        // Sit just above the station's art (pos.y is its mid-height) instead of over the device.
        const stationDef = FURNITURE_DEFS.find((def) => def.key === activeStation);
        const anchorY = pos.y - ((stationDef?.map.length ?? 0) / 2) * (view?.scale ?? 2) - 6;
        const tipTop = Math.max(4, anchorY - stationTipH);
        return (
          <div
            ref={stationTipRef}
            className={`station-tooltip${occupants.length > 0 ? " station-tooltip--busy" : ""}${pinned ? " station-tooltip--pinned" : ""}`}
            style={{ transform: `translate(-50%, 0) translate(${bounds.left + pos.x}px, ${bounds.top + tipTop}px)`, "--station-accent": accent } as CSSProperties}
          >
            <div className="station-tooltip__head">
              <i className="station-tooltip__dot" aria-hidden="true" />
              <strong>{STATION_LABELS[activeStation] ?? activeStation}</strong>
              <span className="station-tooltip__status">
                {occupants.length === 0 ? t("閒置") : t("使用中")}
                {occupants.length > 1 && <b>{occupants.length}</b>}
              </span>
            </div>
            <p className="station-tooltip__desc">{STATION_DESCRIPTIONS[activeStation] ?? ""}</p>
            {occupants.length > 0 && (
              <div className="station-tooltip__list">
                {occupants.map((w) => {
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
                      <span className="station-tooltip__who">
                        <span className="station-tooltip__name">{w.name}</span>
                        {tool ? <span className="station-tooltip__tool">{parseMcpToolName(tool.name).label}</span> : null}
                      </span>
                      {detail && <i className="station-tooltip__detail">{detail}</i>}
                    </button>
                  );
                })}
              </div>
            )}
            {pinned && occupants.length > 0 && <small className="station-tooltip__hint">{t("點名字可開工作日誌")}</small>}
          </div>
        );
      })()}
    </>
  );
}
