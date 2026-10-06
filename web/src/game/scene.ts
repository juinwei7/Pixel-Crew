// Pixi generates some of its render code with `new Function(...)` at runtime.
// Our server sends a strict CSP (`script-src 'self'`, no `unsafe-eval`), which
// blocks that and throws "Current environment does not allow unsafe-eval"
// before a single frame renders. This official polyfill module patches Pixi
// to use precompiled fallbacks instead, so it works under strict CSP without
// loosening it. Must be imported before the first `Application` is created.
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { CharacterState } from "../types";
import type { StationKey } from "../stations";
import { Room, ART_W, ART_H, WALL_H, ROOM_SPOTS, type RoomSpot } from "./room";
import { FurnitureLayer, FURNITURE_DEFS } from "./furniture";
import { Person } from "./person";
import type { EmoteKind } from "./person";
import { ParticleSystem } from "./particles";
import { DiscoParty, OfficeFx, OfficePower, SystemCues, type Lamp, type LinkSpec, type PortalHandle, type Pt, type Rect, type SystemCueKind } from "./officeFx";
import { FloorRipples, Hotspots, type Hotspot } from "./officeInteract";
import { hashId, officeNow, onKonami, seasonal, sessionFlag, setSessionFlag, traitFor } from "./officeLife";
import { ACCESSORIES } from "./person";
import { talkLine } from "./smallTalk";
import { missionCheers } from "./missionCheer";
import { emitFx, onFx } from "../fxBus";
import { dragContainsFiles } from "../composerDrag";
import { PersonalDeskLayer } from "./personalDesks";
import type { DepartmentPhase, DepartmentSeat, DepartmentZone } from "./personalDesks";
import { DECOR_SPOTS, OfficeDecor, OutboxShelf, type DecorSpot } from "./officeDecor";
import { Cat } from "./cat";
import { apiAssetUrl } from "../api";
import { nightFactor } from "../dayNight";
import { officeMinScale, responsiveOfficeFitScale } from "./camera";

const GREEN = 0x37d6a3;
const RED = 0xff5c7a;
const CYAN = 0x4de3ff;

/** Stagger stand spots so several NPCs at one station don't overlap. */
const SPOT_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [-14, 5],
  [14, 5],
  [-25, 10],
  [25, 10],
  [-14, 18],
  [14, 18],
  [0, 22],
  [-28, 22],
  [28, 22],
  // Big crews: a second ring further out so a busy station doesn't stack people.
  [-38, 14],
  [38, 14],
  [-7, 30],
  [7, 30],
  [-21, 32],
  [21, 32],
  [-35, 30],
  [35, 30],
];

/** 會議桌專屬座位：讓 NPC 分坐在長桌上下兩側、沿桌長分散，像真的圍桌開會，而不是擠在同一側。
 *  位移相對於 meeting 站點 (standX, standY)；oy 負得多＝桌子上方（後排），接近 0＝桌子下方（前排）。 */
const MEETING_SEATS: Array<[number, number]> = [
  [-45, 0],
  [-27, 0],
  [-9, 0],
  [9, 0],
  [27, 0],
  [45, 0],
  [-18, 9],
  [18, 9],
];

export type WorkerSceneState = {
  id: string;
  name: string;
  character: CharacterState;
  active: boolean;
  colorIndex: number;
  avatarId: string | null;
  avatarKind: "preset" | "custom";
  avatarPresetId: string;
  selectId: string;
  temporary: boolean;
  /** 老闆交辦臨時部門成員——desk 層據此把整個部門圈進獨立房間。 */
  ephemeral?: boolean;
  /** 部門任務當前步驟的負責人——desk 層畫值勤指標。 */
  onDuty?: boolean;
  /** True while a tool-call approval is waiting on the user. */
  waiting: boolean;
  workspacePath: string;
  departmentKey?: string;
  workspaceLabel: string;
  collaborationPhase: DepartmentPhase;
  collaborationRole: "source" | "target" | null;
  missionProgress?: { completed: number; total: number } | null;
  /** The other end of a running collaboration (source <-> target), for the link beam. */
  collaborationPartnerId?: string | null;
  /** Sub-agents: the worker that summoned them (portal + summon beam start there). */
  parentId?: string;
  /** Context usage 0–100 of the brain-swap budget (ctxGauge); high = tired NPC. */
  ctxPct?: number | null;
};

export type PersonScreenPos = { id: string; x: number; y: number; scale: number; opacity: number };
export type FurnitureScreenPos = { key: StationKey; x: number; y: number };

export type SceneView = { scale: number; minScale: number; maxScale: number; isDefault: boolean };

export type SceneHandle = {
  setWorkers(list: WorkerSceneState[]): void;
  /** Synchronize renderer bounds with the browser-owned canvas host. */
  resize(): void;
  /** Zoom to an integer scale, keeping the screen center anchored. */
  setZoom(nextScale: number): void;
  /** Back to auto-fit scale, centered. */
  resetView(): void;
  /** Office growth decorations (0–3), from all-time completed turns. */
  setMilestone(level: number): void;
  /** Context reset (brain swap / compaction) just happened for this worker — halo flash. */
  brainReset(workerId: string): void;
  destroy(): void;
};

type SceneCallbacks = {
  onPositions(list: PersonScreenPos[]): void;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onHover(id: string | null): void;
  onAvatarError(id: string, message: string): void;
  // Furniture doesn't move, so these only fire once on init and on resize —
  // unlike onPositions, which reports moving people every frame.
  onFurniturePositions?(list: FurnitureScreenPos[]): void;
  onFurnitureHover?(key: StationKey | null): void;
  onFurnitureClick?(key: StationKey): void;
  onDepartmentClick?(workspacePath: string): void;
  onDepartmentRename?(workspacePath: string, position: { x: number; y: number }): void;
  onContextMenu?(id: string): void;
  /** A genuine tap on empty floor (not on an NPC/desk, and not a pan). */
  onEmptyTap?(): void;
  /** Tap on the OUT shelf (bottom-right) — App opens the 成品匣. */
  onOutboxClick?(): void;
  /** Fired whenever the camera (zoom/pan/fit) changes, incl. on resize. */
  onViewChange?(view: SceneView): void;
};

type PersonEntry = {
  person: Person;
  last: CharacterState | null;
  index: number;
  avatarId: string | null;
  avatarKind: "preset" | "custom";
  avatarPresetId: string;
  temporary: boolean;
  transition: "entering" | "ready" | "removing";
  transitionMs: number;
  baseAlpha: number;
  targetX: number;
  targetY: number;
  waiting: boolean;
  selectId: string;
  /** Countdown to the next "pick me" hop while waiting on an approval. */
  hopIn: number;
  /** True while this NPC is off on a social stroll or a delivery — home re-targeting pauses. */
  strolling: boolean;
  /** performance.now() of the last successful turn — picks the courier for unattributed deliverables. */
  lastSuccessAt: number;
  lastHaloAt: number;
  ctxPct: number | null;
  parentId: string | null;
  /** Sub-agent portal while walking in/out of it. */
  portal: PortalHandle | null;
  shrinkAt: number | null;
  /** Leaving the crew for real: wave, "BYE", poof — instead of walking off. */
  farewell: boolean;
  /** Power back on: when this NPC gets up (scene clock), once their ceiling light is lit. */
  wakeAt: number | null;
  /** Glancing at something (a system cue, a floor tap) until this time (scene clock)… */
  glanceUntil: number;
  /** …at this world x. */
  glanceX: number;
  /** Recent pokes (scene clock) — rapid repeats escalate the reaction. */
  pokes: number[];
  /** All pokes this session (20 → sunglasses). */
  pokeTotal: number;
  /** Scene clock when the current stretch of work began (null while idle). */
  busySince: number | null;
  /** Scene-clock times of recent failed turns (repeats escalate the reaction). */
  errors: number[];
  /** Tool stations visited in a row without going idle ("COMBO xN"). */
  chain: number;
  /** Scene clock when the current approval wait began (null when not waiting). */
  waitingSince: number | null;
};

/**
 * Ceiling lights for the power-cut reboot, one per zone, listed in the order
 * they come on: the tool stations along the back wall, then each department
 * (top row first), then the meeting table and the outbox corner.
 */
function officeLamps(departments: DepartmentZone[]): Lamp[] {
  const lamps: Lamp[] = [
    { x: 64, y: 70, rx: 78, ry: 40 },
    { x: 190, y: 70, rx: 78, ry: 40 },
    { x: 316, y: 70, rx: 78, ry: 40 },
    { x: 412, y: 74, rx: 52, ry: 40 },
  ];
  const segments = departments.flatMap((d) => d.segments)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  for (const s of segments) {
    lamps.push({ x: (s.left + s.right) / 2, y: (s.top + s.bottom) / 2, rx: (s.right - s.left) / 2 + 22, ry: (s.bottom - s.top) / 2 + 20 });
  }
  lamps.push({ x: 120, y: 302, rx: 86, ry: 46 }, { x: 410, y: 300, rx: 50, ry: 44 });
  return lamps;
}

const PERSON_ENTER_MS = 1_350;
const REDUCE_MOTION_SCENE =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const PERSON_EXIT_MS = 780;
/** A new worker only beams in once the crew list has been stable this long (not on load / reconnect). */
const CREW_SETTLE_MS = 4_000;
/** More newcomers/leavers than this in one update is a re-snapshot, not people joining or leaving. */
const MAX_ARRIVALS = 3;
const MAX_DEPARTURES = 2;
/** Office plants (drawn by OfficeDecor) and where to stand to water them. */
const PLANTS: Array<{ x: number; y: number; dir: 1 | -1 }> = [
  { x: 27, y: 84, dir: -1 },
  { x: ART_W - 19, y: 84, dir: 1 },
];
/** Where system cues pop up: on the back wall, centre. */
const CUE_AT: Pt = { x: ART_W / 2, y: 38 };

export async function createScene(
  host: HTMLDivElement,
  callbacks: SceneCallbacks,
): Promise<SceneHandle> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: 0x070a14,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio, 2),
    autoDensity: true,
  });
  host.appendChild(app.canvas);
  // Right-click drives our own quick menu instead of the browser's context menu.
  app.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  const world = new Container();
  world.sortableChildren = true;

  // Pixi-native tap-vs-drag detection shared by NPCs and their desks. Native
  // pointer events can silently drop out on touch (a pan fires pointercancel and
  // no pointermove), so movement is tracked through Pixi's own event system — the
  // same one the sprite pointerup fires from, keeping them in sync. Any press that
  // travels past ~6px is a pan, not a tap, so selection (which opens the task log)
  // is suppressed. This is why "finger down on an NPC and drag" no longer selects.
  app.stage.eventMode = "static";
  let pressGX = 0, pressGY = 0, pointerDragged = false;
  app.stage.on("pointerdown", (e) => { pressGX = e.global.x; pressGY = e.global.y; pointerDragged = false; });
  app.stage.on("globalpointermove", (e) => {
    if (!pointerDragged && Math.hypot(e.global.x - pressGX, e.global.y - pressGY) > 6) pointerDragged = true;
  });
  const isDragging = () => pointerDragged;
  // A tap that lands on the stage itself (no interactive sprite caught it) and
  // isn't a pan is an "empty floor" tap — used to dismiss the task log/tooltip.
  app.stage.on("pointerup", (e) => {
    if (!pointerDragged && e.target === app.stage) {
      callbacks.onEmptyTap?.();
      const p = world.toLocal(e.global);
      floorTap(p.x, p.y);
    }
  });

  const room = new Room();
  const furniture = new FurnitureLayer(
    (key) => {
      overInteractive = key !== null;
      callbacks.onFurnitureHover?.(key);
    },
    (key) => callbacks.onFurnitureClick?.(key),
  );
  const particles = new ParticleSystem();
  const personalDesks = new PersonalDeskLayer(
    callbacks.onSelect,
    callbacks.onDepartmentClick,
    callbacks.onDepartmentRename,
    isDragging,
  );
  const officeDecor = new OfficeDecor();
  const cat = new Cat();
  const fx = new OfficeFx(world);
  const shelf = new OutboxShelf();

  room.container.zIndex = -1000;
  particles.g.zIndex = 10000;
  // （試過用大橢圓光暈做室內燈光——pixi Graphics 沒有漸層，實機上看起來是幾個
  //   突兀的「奇怪圓圈」，已拿掉。要做燈光得用貼圖或濾鏡，之後再議。）
  // Power cut dimmer (+ the "z z" of the dozing crew) and the system-cue icons.
  const power = new OfficePower({ x: 0, y: 0, w: ART_W, h: ART_H }, { x: ART_W / 2, y: 40 }, { x: 248, y: 6, w: 88, h: 38 });
  const cues = new SystemCues();
  // Konami-code dance party.
  const party = new DiscoParty({ x: 0, y: 0, w: ART_W, h: ART_H }, { x: ART_W / 2, y: 0 });
  world.addChild(room.container, personalDesks.container, officeDecor.container, shelf.container, particles.g, cat.container, fx.air, power.view, cues.g, party.view);

  // Clickable decor: purely visual reactions, hover shows corner brackets.
  // A tap on decor still counts as "tapped the room" for the UI (closes the log).
  const ripples = new FloorRipples();
  world.addChild(ripples.g);
  const decorSpots: Hotspot[] = [
    ...(Object.keys(ROOM_SPOTS) as RoomSpot[]).map((key): Hotspot => ({
      key, rect: ROOM_SPOTS[key], z: -500, poke: () => room.poke(key),
    })),
    ...(Object.keys(DECOR_SPOTS) as DecorSpot[]).map((key): Hotspot => ({
      key,
      rect: DECOR_SPOTS[key],
      z: key === "neon" ? -400 : DECOR_SPOTS[key].y + DECOR_SPOTS[key].h,
      poke: () => {
        officeDecor.poke(key);
        if (key === "coffee") for (let i = 0; i < 3; i++) particles.rise(396, 68, 0xdfe9f8, 4);
      },
      enabled: key === "neon" ? () => officeDecor.neonShown
        : key === "tree" ? () => officeDecor.seasonNow.xmas
        : key === "pizza" ? () => officeDecor.seasonNow.pizza
        : undefined,
    })),
  ];
  const hotspots = new Hotspots(world, decorSpots, {
    isDragging: () => isDragging(),
    onHover: (key) => { overInteractive = key !== null; },
    onTap: () => callbacks.onEmptyTap?.(),
  });
  // The OUT shelf opens the 成品匣 (same tap-not-pan rule as the cat).
  shelf.container.eventMode = "static";
  shelf.container.cursor = "pointer";
  shelf.container.hitArea = { contains: (x: number, y: number) => x >= -13 && x <= 13 && y >= -27 && y <= 2 };
  {
    let shelfPid = -1;
    shelf.container.on("pointerdown", (e) => { shelfPid = e.pointerId; });
    shelf.container.on("pointerup", (e) => {
      if (e.pointerId !== shelfPid) return;
      shelfPid = -1;
      if (!isDragging()) callbacks.onOutboxClick?.();
    });
  }
  // The cat answers clicks too (meow, hop, purr).
  cat.container.eventMode = "static";
  cat.container.cursor = "pointer";
  cat.container.hitArea = { contains: (x: number, y: number) => x >= -6 && x <= 6 && y >= -9 && y <= 2 };
  {
    let catPid = -1;
    cat.container.on("pointerdown", (e) => { catPid = e.pointerId; });
    cat.container.on("pointerup", (e) => {
      if (e.pointerId !== catPid) return;
      catPid = -1;
      if (!isDragging()) cat.poke();
    });
  }

  // 日夜循環只作用在窗外：天空顏色照真實時間依關鍵影格連續漸變（白天亮藍、
  // 黃昏燒橘、入夜深藍），星星/太陽/月亮跟著切。室內不蓋色紗，場景維持原色。
  // night 係數走 dayNight.ts 共用曲線（與 3D 主題同一條）；天空色是像素風專屬關鍵影格。
  const DAYLIGHT_KEYS: Array<{ h: number; sky: number }> = [
    { h: 0, sky: 0x080c1a },    // 深夜
    { h: 5, sky: 0x080c1a },    // 黎明前最暗
    { h: 6.5, sky: 0xd98a5a },  // 清晨暖橘
    { h: 9, sky: 0x6fb7e8 },    // 白天亮藍
    { h: 17, sky: 0x6fb7e8 },   // 白天撐到 17:00 才開始轉黃昏
    { h: 18.5, sky: 0xe8845a }, // 黃昏燒橘
    { h: 20, sky: 0x080c1a },   // 入夜
    { h: 24, sky: 0x080c1a },
  ];

  function lerpColor(a: number, b: number, t: number): number {
    const ch = (shift: number) => {
      const from = (a >> shift) & 0xff;
      return Math.round(from + (((b >> shift) & 0xff) - from) * t) << shift;
    };
    return ch(16) | ch(8) | ch(0);
  }

  function daylightSky(hourFloat: number): number {
    let prev = DAYLIGHT_KEYS[0];
    for (const key of DAYLIGHT_KEYS) {
      if (hourFloat <= key.h) {
        const t = key.h === prev.h ? 0 : (hourFloat - prev.h) / (key.h - prev.h);
        return lerpColor(prev.sky, key.sky, t);
      }
      prev = key;
    }
    return DAYLIGHT_KEYS[DAYLIGHT_KEYS.length - 1].sky;
  }

  function applyDaylight(): void {
    const now = officeNow();
    const hourFloat = now.getHours() + now.getMinutes() / 60;
    officeDecor.setSeasonal(seasonal(now));
    room.setSky(daylightSky(hourFloat));
    room.setNight(nightFactor(hourFloat) >= 0.5);
    room.setClock(now);
  }
  applyDaylight();
  for (const child of [...furniture.container.children]) {
    world.addChild(child);
  }

  const labelLayer = new Container();
  const labels = FURNITURE_DEFS.map((def) => {
    const text = new Text({
      text: def.label,
      style: {
        fill: 0x8fb8e8,
        fontSize: 12,
        fontFamily: "'PingFang TC', 'Noto Sans TC', sans-serif",
        letterSpacing: 1,
      },
    });
    text.anchor.set(0.5, 0);
    labelLayer.addChild(text);
    return { def, text };
  });

  app.stage.addChild(world, labelLayer);

  // 像素世界不套任何額外的全域濾鏡皮膚層，保留清晰的像素原色。

  let scale = 1;
  let fitScale = 2;
  // User camera: null scale = auto-fit; pan offsets are relative to the
  // centered position, clamped so the room can never be dragged fully
  // off-screen. Double-click on empty floor resets everything.
  let userScale: number | null = null;
  let panX = 0;
  let panY = 0;

  // Big crews make the floor taller than the main office (annex). The camera
  // then fits the whole floor when it can, may zoom out below 2x, and starts
  // at the top when even that doesn't fit; small crews get exactly the old view.
  let floorH = ART_H;
  function minScale(): number {
    return officeMinScale(floorH, ART_H);
  }
  function autoScale(): number {
    if (floorH <= ART_H) return fitScale;
    // Fit the whole floor when it fits at a readable size; otherwise start at
    // 1.5x from the top (pan / zoom out to 1x for the full overview).
    return Math.max(Math.min(1.5, fitScale), minScale(), Math.min(fitScale, (app.screen.height - 16) / floorH));
  }
  function baseOffset(s: number): Pt {
    const w = app.screen.width;
    const h = app.screen.height;
    const tall = floorH * s > h;
    return {
      x: Math.floor((w - ART_W * s) / 2),
      y: floorH <= ART_H || !tall ? Math.floor((h - floorH * s) / 2) : 8,
    };
  }

  function applyView(): void {
    const w = app.screen.width;
    const h = app.screen.height;
    scale = Math.max(minScale(), Math.min(userScale ?? autoScale(), fitScale + 4));
    world.scale.set(scale);
    const { x: baseX, y: baseY } = baseOffset(scale);
    const keep = 140;
    panX = Math.min(w - keep - baseX, Math.max(keep - (baseX + ART_W * scale), panX));
    panY = Math.min(h - keep - baseY, Math.max(keep - (baseY + floorH * scale), panY));
    world.position.set(Math.round(baseX + panX), Math.round(baseY + panY));
    for (const { def, text } of labels) {
      text.position.set(
        world.position.x + def.x * scale,
        world.position.y + (def.bottom + 3) * scale,
      );
    }
    callbacks.onFurniturePositions?.(FURNITURE_DEFS.filter((def) => def.label).map((def) => ({
      key: def.key,
      x: world.position.x + def.x * scale,
      y: world.position.y + (def.bottom - def.map.length / 2) * scale,
    })));
    callbacks.onViewChange?.({
      scale,
      minScale: minScale(),
      maxScale: fitScale + 4,
      isDefault: userScale === null && panX === 0 && panY === 0,
    });
  }

  function layout(): void {
    // Width alone can request more vertical room than a short-but-wide
    // viewport has available (e.g. after docking panels) — cap by height too,
    // like the office always has, so the default view never clips the room.
    const heightFitScale = Math.floor(app.screen.height / ART_H);
    fitScale = Math.max(2, Math.min(responsiveOfficeFitScale(app.screen.width), heightFitScale));
    applyView();
  }
  layout();
  app.renderer.on("resize", layout);

  // --- Camera controls: drag empty space to pan, wheel to zoom (anchored at
  // the cursor), double-click the floor to reset. Sprite/furniture handlers
  // keep working — a drag only starts panning past a small threshold, so
  // ordinary clicks are unaffected.
  let overInteractive = false;
  let dragId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragLastX = 0;
  let dragLastY = 0;
  let dragPanning = false;

  // Live positions of every pointer currently down on the canvas. Two of them
  // means a pinch: zoom by the ratio of their distance, anchored at their
  // midpoint — the touch equivalent of the wheel handler below.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  const pinchGeometry = () => {
    const [a, b] = [...pointers.values()];
    const rect = app.canvas.getBoundingClientRect();
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2 - rect.left,
      cy: (a.y + b.y) / 2 - rect.top,
    };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      // Second finger down → start a pinch and abandon any single-finger pan.
      dragId = null;
      dragPanning = false;
      const g = pinchGeometry();
      pinchStartDist = g.dist;
      pinchStartScale = scale;
      return;
    }
    dragId = event.pointerId;
    dragPanning = false;
    dragStartX = dragLastX = event.clientX;
    dragStartY = dragLastY = event.clientY;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const g = pinchGeometry();
      if (pinchStartDist > 0) zoomAnchored(pinchStartScale * (g.dist / pinchStartDist), g.cx, g.cy);
      return;
    }
    if (dragId !== event.pointerId) return;
    if (!dragPanning && Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < 5) return;
    dragPanning = true;
    panX += event.clientX - dragLastX;
    panY += event.clientY - dragLastY;
    dragLastX = event.clientX;
    dragLastY = event.clientY;
    applyView();
  };
  const onPointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (dragId === event.pointerId) dragId = null;
    if (pointers.size < 2) pinchStartDist = 0;
    // One finger left after a pinch → hand panning back to it without a jump.
    if (pointers.size === 1) {
      const [[id, p]] = [...pointers.entries()];
      dragId = id;
      dragPanning = false;
      dragStartX = dragLastX = p.x;
      dragStartY = dragLastY = p.y;
    }
  };
  // Continuous, not stepped to integers — smooth zoom in/out at any size,
  // only clamped at the min/max bounds.
  function zoomAnchored(next: number, cx: number, cy: number): void {
    const clamped = Math.max(minScale(), Math.min(fitScale + 4, next));
    if (clamped === scale) return;
    const wx = (cx - world.position.x) / scale;
    const wy = (cy - world.position.y) / scale;
    userScale = clamped;
    panX = cx - wx * clamped - Math.floor((app.screen.width - ART_W * clamped) / 2);
    panY = cy - wy * clamped - baseOffset(clamped).y;
    applyView();
  }

  // Multiplicative (not additive) so the same physical scroll gesture feels
  // consistent whether zoomed way in or out, and scales smoothly with
  // however much deltaY a given event reports — no discrete per-event jump,
  // no accumulation/threshold games. A notched mouse wheel's larger deltaY
  // naturally produces a bigger single step; a trackpad's stream of tiny
  // deltaY events naturally produces a smooth, continuous zoom.
  const WHEEL_ZOOM_SENSITIVITY = 0.0018;
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const rect = app.canvas.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
    zoomAnchored(scale * factor, event.clientX - rect.left, event.clientY - rect.top);
  };
  function resetView(): void {
    userScale = null;
    panX = 0;
    panY = 0;
    applyView();
  }

  const onDoubleClick = () => {
    if (overInteractive) return;
    resetView();
  };
  app.canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  app.canvas.addEventListener("wheel", onWheel, { passive: false });
  app.canvas.addEventListener("dblclick", onDoubleClick);

  const entries = new Map<string, PersonEntry>();
  // Seats depend on the whole crew's department packing, not the worker's
  // index alone — refreshed from the desk layout on every setWorkers.
  let homeSeats = new Map<string, DepartmentSeat>();
  // Every permanent worker id the scene has ever shown, and when the first
  // crew list arrived — the gate that keeps beam-ins for real newcomers.
  const knownIds = new Set<string>();
  let crewBaselineAt: number | null = null;
  let elapsed = 0;
  let daylightAccum = 0;
  let idleEmoteAccum = 0;
  let idleEmoteNext = 10_000;

  // --- Idle social: occasionally one idle NPC strolls over to another for a
  // short coffee chat, then walks home. Purely visual; aborts the moment
  // either participant gets real work.
  type Social = {
    stage: "walking" | "chatting" | "returning";
    /** chat: alternating speech dots · highfive: quick slap · coffee: both stroll to the machine. */
    mode: "chat" | "highfive" | "coffee" | "handshake";
    visitor: PersonEntry;
    host: PersonEntry;
    chatMs: number;
  };
  let social: Social | null = null;
  let socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);

  function socialEligible(entry: PersonEntry): boolean {
    return entry.transition === "ready" && !entry.temporary && !entry.waiting && delivery?.entry !== entry &&
      entry.last?.station === "home" && entry.last.activity !== "working" && entry.last.activity !== "thinking";
  }

  function endSocial(): void {
    if (!social) return;
    for (const entry of [social.visitor, social.host]) {
      entry.person.emote("chat", 0);
      entry.person.emote("coffee", 0);
    }
    social.visitor.strolling = false;
    social.visitor.person.setTarget(social.visitor.targetX, social.visitor.targetY);
    if (social.mode === "coffee") {
      social.host.strolling = false;
      social.host.person.setTarget(social.host.targetX, social.host.targetY);
    }
    social = null;
    socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);
  }

  function updateSocial(dt: number): void {
    if (social) {
      const { visitor, host } = social;
      if (!socialEligible(visitor) || !socialEligible(host) || !entries.has(idOf(visitor)) || !entries.has(idOf(host))) {
        endSocial();
        return;
      }
      if (social.stage === "walking") {
        if (!visitor.person.isMoving && !host.person.isMoving) {
          social.stage = "chatting";
          social.chatMs = social.mode === "highfive" ? 1_300 : social.mode === "handshake" ? 2_600 : social.mode === "coffee" ? 5_000 : 4_400;
          if (social.mode === "highfive" || social.mode === "handshake") {
            const dir = visitor.person.x < host.person.x ? 1 : -1;
            visitor.person.highFive(dir as 1 | -1);
            host.person.highFive(-dir as 1 | -1);
          }
        }
      } else if (social.stage === "chatting") {
        const before = social.chatMs;
        social.chatMs -= dt;
        if (social.mode === "highfive") {
          // The slap: a little star burst between the raised hands.
          if (before > 900 && social.chatMs <= 900) {
            particles.burst((visitor.person.x + host.person.x) / 2, visitor.person.y - 17, GOLD, 8, 0.03);
          }
        } else if (social.mode === "handshake") {
          // Old collaborators' secret handshake: high five → hop together → a twirl each → hearts.
          const mid = (visitor.person.x + host.person.x) / 2;
          if (before > 2_000 && social.chatMs <= 2_000) particles.burst(mid, visitor.person.y - 17, GOLD, 6, 0.03);
          if (before > 1_500 && social.chatMs <= 1_500) { visitor.person.hop(); host.person.hop(); }
          if (before > 1_100 && social.chatMs <= 1_100) { visitor.person.microAct("spin"); host.person.microAct("spin"); }
          if (before > 300 && social.chatMs <= 300) {
            visitor.person.emote("heart", 1_200);
            host.person.emote("heart", 1_200);
            particles.burst(mid, visitor.person.y - 12, 0xff8fc8, 8, 0.03);
          }
        } else {
          // Taking turns talking: the speech dots hop from one to the other.
          const talker = Math.floor(social.chatMs / 1_100) % 2 === 0 ? visitor : host;
          const listener = talker === visitor ? host : visitor;
          talker.person.emote("chat", 600);
          if (social.mode === "coffee") listener.person.emote("coffee", 600);
          else if (listener.person.emoting === "chat") listener.person.emote("chat", 0);
        }
        if (social.chatMs <= 0) {
          social.stage = "returning";
          for (const entry of [visitor, host]) {
            entry.person.emote("chat", 0);
            entry.person.emote("coffee", 0);
          }
          visitor.person.setTarget(visitor.targetX, visitor.targetY);
          if (social.mode === "coffee") host.person.setTarget(host.targetX, host.targetY);
        }
      } else if (!visitor.person.isMoving && !host.person.isMoving) {
        visitor.strolling = false;
        host.strolling = social.mode === "coffee" ? false : host.strolling;
        social = null;
        socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);
      }
      return;
    }
    socialCooldown -= dt;
    if (socialCooldown > 0) return;
    socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);
    const idle = [...entries.values()].filter((entry) => socialEligible(entry) && !entry.strolling && entry.person.acting === null);
    if (idle.length < 2) return;
    // Social butterflies start conversations more often.
    const social1 = idle.filter((entry) => entry.person.trait === "social");
    const visitor = social1.length && Math.random() < 0.6 ? social1[Math.floor(Math.random() * social1.length)] : idle[Math.floor(Math.random() * idle.length)];
    const others = idle.filter((entry) => entry !== visitor);
    const host = others[Math.floor(Math.random() * others.length)];
    // Old collaborators get their own handshake.
    const buddy = others.find((other) => areFriends(idOf(visitor), idOf(other)));
    if (buddy && Math.random() < 0.7) {
      startSocial("handshake", visitor, buddy);
      return;
    }
    const roll = Math.random();
    startSocial(roll < 0.45 ? "chat" : roll < 0.75 ? "highfive" : "coffee", visitor, host);
  }

  function startSocial(mode: Social["mode"], visitor: PersonEntry, host: PersonEntry): void {
    if (social) endSocial();
    visitor.strolling = true;
    if (mode === "coffee") {
      // Both wander over to the coffee machine.
      host.strolling = true;
      visitor.person.setTarget(392, 96);
      host.person.setTarget(411, 96);
    } else {
      const side = visitor.person.x <= host.person.x ? -1 : 1;
      visitor.person.setTarget(
        Math.max(8, Math.min(ART_W - 8, host.person.x + side * (mode === "highfive" || mode === "handshake" ? 9 : 12))),
        Math.max(52, Math.min(floorH - 6, host.person.y)),
      );
    }
    social = { stage: "walking", mode, visitor, host, chatMs: 0 };
  }

  function idOf(entry: PersonEntry): string {
    for (const [id, candidate] of entries) if (candidate === entry) return id;
    return "";
  }

  function standSpot(station: StationKey, index: number, id?: string): { x: number; y: number } {
    if (station === "home") {
      const seat = id ? homeSeats.get(id) : undefined;
      return seat ? { x: seat.x, y: seat.y } : { x: ART_W / 2, y: ART_H - 30 };
    }
    const def = furniture.def(station);
    const seats = station === "meeting" ? MEETING_SEATS : SPOT_OFFSETS;
    const [ox, oy] = seats[index % seats.length];
    return {
      x: Math.max(8, Math.min(ART_W - 8, def.standX + ox)),
      y: Math.max(52, Math.min(ART_H - 6, def.standY + oy)),
    };
  }

  function applyCharacter(entry: PersonEntry, next: CharacterState, id: string): void {
    const prev = entry.last;
    entry.last = next;
    const { person, index } = entry;

    if ((!prev || prev.station !== next.station) && entry.transition === "ready") {
      const spot = standSpot(next.station, index, id);
      person.setTarget(spot.x, spot.y);
      // Off to a tool station: grab the laptop (screens) or a stack of papers (reading, board, tools).
      if (next.station !== "home" && next.station !== "meeting") {
        person.walkProp = next.station === "books" || next.station === "board" || next.station === "desk" ? "papers" : "laptop";
      }
    }
    person.activity = next.activity;
    person.station = next.station;
    // Hopping from tool to tool without a break: "COMBO xN".
    if (next.activity === "idle") entry.chain = 0;
    else if (prev && prev.station !== next.station && next.activity === "working" && next.station !== "home" && next.station !== "meeting") {
      entry.chain += 1;
      if (entry.chain >= 3) person.combo(entry.chain);
    }

    // While the lights are out / just coming back, a re-snapshot can carry
    // turns that finished meanwhile — no checkmark-and-confetti burst for those.
    const quiet = power.dark || performance.now() - linkUpAt < 2_500;
    if (prev && next.bump !== prev.bump && next.mood !== "neutral" && !quiet) {
      const success = next.mood === "success";
      // Mostly a small celebration (jump / fist pump / little dance); now and then the big one with fireworks.
      const big = success && Math.random() < 0.12;
      person.flash(success ? GREEN : RED, false);
      if (success) {
        const kinds = ["jump", "fistpump", "dance"] as const;
        person.celebrate(big ? "big" : kinds[Math.floor(Math.random() * kinds.length)]);
      }
      // The monitor where the turn ended shows the verdict: big check (+ confetti if big), or red glitch + smoke.
      person.showResult(success, big);
      particles.burst(person.x, person.y - 8, success ? GREEN : RED, success ? 14 : 18, 0.045);
      if (success) {
        entry.lastSuccessAt = performance.now();
        // A lingering "✓" spark makes a finished turn as readable as the
        // "cloud" that marks a failed one, not just a single-frame flash.
        person.emote("spark", 2_600);
        // The nearest teammate or two gives a thumbs up (a big win gets everyone close cheering).
        const near = [...entries.values()]
          .filter((other) => other !== entry && !other.temporary && other.transition === "ready" && !other.person.asleep)
          .map((other) => ({ other, d: Math.hypot(other.person.x - person.x, other.person.y - person.y) }))
          .filter(({ d }) => d <= 60)
          .sort((a, b) => a.d - b.d);
        near.slice(0, big ? 4 : 2).forEach(({ other }) => (big ? other.person.cheer() : other.person.thumbsUp()));
        if (Math.random() < 0.5) trySay(entry, talkLine({ kind: "success" }));
      } else {
        // Facepalm / desk kick / scratch; failing again soon after earns a glare.
        entry.errors = entry.errors.filter((t) => elapsed - t < 120_000);
        entry.errors.push(elapsed);
        trySay(entry, person.reactError(entry.errors.length));
      }
    }
  }

  // ───────────────────────── Interaction effects ─────────────────────────
  // Everything below is visual only. Real triggers arrive on the fxBus
  // (dispatch / deliverable from the UI) or are derived from worker state
  // (approvals, collaborations, sub-agents, context usage).

  const GOLD = 0xffd166;

  function clientToWorld(clientX: number, clientY: number): Pt {
    const rect = app.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - world.position.x) / scale,
      y: (clientY - rect.top - world.position.y) / scale,
    };
  }

  /** Keep a launch point on screen: a plane "from" a button outside the canvas enters at the nearest edge. */
  function clampToView(p: Pt): Pt {
    const left = -world.position.x / scale + 4;
    const top = -world.position.y / scale + 4;
    const right = (app.screen.width - world.position.x) / scale - 4;
    const bottom = (app.screen.height - world.position.y) / scale - 4;
    return { x: Math.max(left, Math.min(right, p.x)), y: Math.max(top, Math.min(bottom, p.y)) };
  }

  /** Chest-height point of a live NPC, or null once they're gone. */
  function chestOf(id: string): () => Pt | null {
    return () => {
      const entry = entries.get(id);
      if (!entry || entry.transition === "removing") return null;
      return { x: entry.person.x, y: entry.person.y - 10 };
    };
  }

  // --- 1. Paper-plane dispatch: the task flies from the submit button to the NPC.
  function playDispatch(id: string, from: Pt): void {
    const entry = entries.get(id);
    if (!entry || entry.temporary || entry.transition === "removing") return;
    fx.plane(
      clampToView(from),
      chestOf(id),
      (at) => {
        entry.person.catchIt();
        entry.person.rush(4_000); // off to work at a little run
        particles.burst(at.x, at.y, 0xdfe9f8, 6, 0.03);
      },
      () => entry.person.reachFor(450),
    );
  }

  // --- 3. Deliverables: the NPC carries a box to the outbox shelf. One courier
  // at a time keeps it calm; others queue until they're free (a deliverable
  // written mid-turn waits for the turn to end instead of abandoning work).
  type Delivery = { entry: PersonEntry; id: string; stage: "toShelf" | "drop"; t: number; dropped: boolean };
  let delivery: Delivery | null = null;
  const pendingDeliveries = new Map<string, number>(); // id -> queued at
  const DELIVERY_TTL_MS = 120_000;

  function queueDelivery(workerId: string | null): void {
    let id = workerId && entries.get(workerId) && !entries.get(workerId)!.temporary ? workerId : null;
    if (!id) {
      // Unattributed: whoever finished a turn most recently carries it.
      let best = 0;
      for (const [candidate, entry] of entries) {
        if (!entry.temporary && entry.lastSuccessAt > best) {
          best = entry.lastSuccessAt;
          id = candidate;
        }
      }
    }
    if (id && !pendingDeliveries.has(id)) pendingDeliveries.set(id, performance.now());
  }

  function deliveryEligible(entry: PersonEntry): boolean {
    return entry.transition === "ready" && !entry.temporary && !entry.waiting && !entry.strolling &&
      entry.last !== null && entry.last.activity !== "working" && entry.last.activity !== "thinking";
  }

  function endDelivery(requeue: boolean): void {
    if (!delivery) return;
    const { entry, id } = delivery;
    entry.person.carrying = false;
    entry.strolling = false;
    entry.person.setTarget(entry.targetX, entry.targetY);
    if (requeue) pendingDeliveries.set(id, performance.now());
    delivery = null;
  }

  function updateDeliveries(dt: number): void {
    if (delivery) {
      const { entry, id } = delivery;
      if (entries.get(id) !== entry || entry.transition !== "ready" || entry.waiting ||
        entry.last?.activity === "working" || entry.last?.activity === "thinking") {
        endDelivery(!delivery.dropped);
        return;
      }
      const spot = shelf.standSpot;
      if (delivery.stage === "toShelf") {
        if (entry.person.isMoving) return;
        if (Math.hypot(entry.person.x - spot.x, entry.person.y - spot.y) > 2) {
          entry.person.setTarget(spot.x, spot.y); // something re-routed them; carry on
          return;
        }
        delivery.stage = "drop";
        delivery.t = 0;
        return;
      }
      delivery.t += dt;
      if (!delivery.dropped && delivery.t >= 260) {
        delivery.dropped = true;
        entry.person.carrying = false;
        shelf.receive();
        const drop = shelf.dropPoint;
        particles.burst(drop.x, drop.y, GOLD, 10, 0.035);
        for (let i = 0; i < 4; i++) particles.rise(drop.x, drop.y - 2, GOLD, 10);
        entry.person.emote("spark", 1_400);
      }
      if (delivery.t >= 1_000) endDelivery(false); // walk back to the desk
      return;
    }
    if (pendingDeliveries.size === 0) return;
    const now = performance.now();
    for (const [id, at] of pendingDeliveries) {
      const entry = entries.get(id);
      if (!entry || now - at > DELIVERY_TTL_MS) {
        pendingDeliveries.delete(id);
        continue;
      }
      if (!deliveryEligible(entry)) continue;
      pendingDeliveries.delete(id);
      entry.strolling = true;
      entry.person.carrying = true;
      const spot = shelf.standSpot;
      entry.person.setTarget(spot.x, spot.y);
      delivery = { entry, id, stage: "toShelf", t: 0, dropped: false };
      return;
    }
  }

  // --- 6. Fatigue and brain reset.
  let fatigueAccum = 0;
  let fatigueNext = 7_000 + Math.random() * 6_000;
  function updateFatigue(dt: number): void {
    fatigueAccum += dt;
    if (fatigueAccum < fatigueNext) return;
    fatigueAccum = 0;
    fatigueNext = 8_000 + Math.random() * 8_000;
    const tired = [...entries.values()].filter((entry) =>
      entry.transition === "ready" && !entry.temporary && !entry.waiting && !entry.strolling &&
      (entry.ctxPct ?? 0) >= 70 && !entry.person.isMoving && entry.person.emoting === null,
    );
    if (tired.length === 0) return;
    const pick = tired[Math.floor(Math.random() * tired.length)];
    // At the desk (back to camera) they just reach for the mug; facing us, a proper yawn first.
    if (pick.last?.activity === "working") pick.person.emote("coffee", 2_400);
    else pick.person.yawn();
  }

  function brainReset(id: string): void {
    const entry = entries.get(id);
    if (!entry || entry.temporary || entry.transition === "removing") return;
    const now = performance.now();
    if (now - entry.lastHaloAt < 4_000) return; // drop-detection and the swap event can both fire
    entry.lastHaloAt = now;
    entry.person.brainReset();
    for (let i = 0; i < 3; i++) particles.rise(entry.person.x, entry.person.y - 18, 0x9ff3ff, 10);
  }

  // --- 8. More idle life: now and then someone waters a plant, or calls the
  // office cat over for a pat. Low frequency, one at a time, aborted the
  // moment the NPC gets real work (same rules as the coffee chat).
  function lifeEligible(entry: PersonEntry): boolean {
    return socialEligible(entry) && !entry.strolling && !entry.person.isMoving && !entry.person.asleep &&
      social?.visitor !== entry && social?.host !== entry;
  }
  type Chore = { kind: "water" | "pet"; entry: PersonEntry; stage: "going" | "doing" | "back"; t: number; dir: 1 | -1; spot: Pt };
  let chore: Chore | null = null;
  let choreCooldown = 40_000 + Math.random() * 40_000;

  function startChore(kind: "water" | "pet", entry: PersonEntry): boolean {
    if (chore || !lifeEligible(entry)) return false;
    if (kind === "water") {
      const plant = PLANTS[entry.person.x < ART_W / 2 ? 0 : 1];
      entry.strolling = true;
      entry.person.setTarget(plant.x, plant.y);
      chore = { kind, entry, stage: "going", t: 0, dir: plant.dir, spot: { x: plant.x, y: plant.y } };
      return true;
    }
    // The cat trots over and sits beside them.
    const dir: 1 | -1 = cat.pos.x < entry.person.x ? -1 : 1;
    const spot = { x: Math.max(8, Math.min(ART_W - 8, entry.person.x + dir * 8)), y: entry.person.y + 1 };
    if (!cat.visit(spot.x, spot.y)) return false;
    chore = { kind, entry, stage: "going", t: 0, dir, spot };
    return true;
  }

  function endChore(): void {
    if (!chore) return;
    if (chore.kind === "water") {
      chore.entry.strolling = false;
      chore.entry.person.setTarget(chore.entry.targetX, chore.entry.targetY);
    }
    chore = null;
    choreCooldown = 40_000 + Math.random() * 40_000;
  }

  function updateChores(dt: number): void {
    if (!chore) {
      choreCooldown -= dt;
      if (choreCooldown > 0 || REDUCE_MOTION_SCENE) return;
      choreCooldown = 40_000 + Math.random() * 40_000;
      const idle = [...entries.values()].filter(lifeEligible);
      if (idle.length === 0) return;
      startChore(Math.random() < 0.5 ? "water" : "pet", idle[Math.floor(Math.random() * idle.length)]);
      return;
    }
    const { entry } = chore;
    const stillOurs = entries.has(idOf(entry)) && socialEligible(entry) && !entry.person.asleep;
    if (!stillOurs && chore.stage !== "back") {
      endChore();
      return;
    }
    chore.t += dt;
    if (chore.stage === "going") {
      const arrived = chore.kind === "water"
        ? !entry.person.isMoving
        : cat.settled && Math.hypot(cat.pos.x - chore.spot.x, cat.pos.y - chore.spot.y) < 2;
      if (arrived) {
        chore.stage = "doing";
        chore.t = 0;
        entry.person.microAct(chore.kind, chore.dir);
      } else if (chore.t > 14_000) {
        endChore(); // the cat wandered off / got stuck — never mind
      }
    } else if (chore.stage === "doing") {
      if (chore.kind === "water" && chore.t > 900 && Math.random() < 0.08) {
        particles.rise(chore.spot.x + chore.dir * 11, chore.spot.y - 14, GREEN, 6);
      }
      if (chore.t >= 2_800) {
        if (chore.kind === "water") {
          chore.stage = "back";
          entry.person.emote("spark", 1_200);
          entry.person.setTarget(entry.targetX, entry.targetY);
        } else {
          endChore();
        }
      }
    } else if (!entry.person.isMoving || !entries.has(idOf(entry))) {
      endChore();
    }
  }

  // --- 11. Poking NPCs and tapping the floor (visual only).
  function pokeEntry(entry: PersonEntry): void {
    if (entry.transition !== "ready" || entry.temporary) return;
    entry.pokes = entry.pokes.filter((t) => elapsed - t < 2_500);
    entry.pokes.push(elapsed);
    const level = entry.pokes.length;
    entry.pokeTotal += 1;
    if (entry.pokeTotal === 20 && !entry.person.sunglasses) {
      // Easter egg: poke someone twenty times and they put on shades (for the session).
      entry.person.sunglasses = true;
      setSessionFlag(`shades:${idOf(entry)}`);
      entry.person.emote("spark", 1_600);
      particles.burst(entry.person.x, entry.person.y - 12, GOLD, 10, 0.03);
      entry.pokes = [];
      return;
    }
    entry.person.poke(level);
    if (level >= 5) entry.pokes = []; // dizzy resets the count
  }

  function floorTap(x: number, y: number): void {
    if (y < WALL_H + 2 || y > floorH || x < 0 || x > ART_W) return;
    ripples.add(x, y);
    // Anyone idle nearby glances at the spot.
    for (const entry of entries.values()) {
      if (entry.temporary || entry.transition !== "ready") continue;
      if (Math.hypot(entry.person.x - x, entry.person.y - y) > 80) continue;
      entry.glanceUntil = elapsed + 1_300;
      entry.glanceX = x;
    }
  }

  // --- 12. Easter eggs: Konami dance party, rare UFO / mouse chase.
  function startParty(): void {
    if (power.isDown) return; // no dancing in the dark (fine while the lights are coming back)
    party.start(8_000);
    for (const entry of entries.values()) {
      if (entry.transition === "ready") entry.person.dance(7_600);
    }
  }
  const offKonami = onKonami(startParty);

  let rareAccum = 0;
  function updateRare(dt: number): void {
    rareAccum += dt;
    if (rareAccum < 20_000) return;
    rareAccum = 0;
    if (Math.random() >= 0.01 || power.dark) return;
    if (Math.random() < 0.5) room.ufo();
    else cat.chaseMouse();
  }

  // --- 13. Small talk: short context lines, rare, never more than one every few seconds.
  let lastTalkAt = -Infinity;
  let talkAccum = 0;
  const TALK_GAP_MS = 6_000;
  function trySay(entry: PersonEntry, line: string | null, force = false): void {
    if (!line) return;
    if (!force && elapsed - lastTalkAt < TALK_GAP_MS) return;
    lastTalkAt = elapsed;
    entry.person.say(line, 2_000);
  }

  function updateTalk(dt: number): void {
    talkAccum += dt;
    if (talkAccum < 4_500) return;
    talkAccum = 0;
    if (elapsed - lastTalkAt < TALK_GAP_MS || Math.random() > 0.35 || power.dark) return;
    // Someone on screen, not selected (the UI's speech bubble lives there), not mid-emote.
    const candidates = [...entries.values()].filter((entry) =>
      entry.transition === "ready" && !entry.temporary && entry.person.container.visible && !entry.person.active &&
      entry.person.emoting === null && !entry.person.asleep && !entry.person.isMoving,
    );
    if (candidates.length === 0) return;
    const entry = candidates[Math.floor(Math.random() * candidates.length)];
    const state = entry.last;
    trySay(entry, talkLine({
      kind: entry.waiting ? "waiting" : state?.activity === "working" ? "working" : state?.activity === "thinking" ? "thinking" : "idle",
      station: state?.station,
      impatient: entry.person.impatient,
      tired: entry.person.tired,
      lateNight: seasonal(officeNow()).lateNight,
      trait: entry.person.trait,
    }));
  }

  // --- 14. Relationships: pairs who keep collaborating become friends
  // (remembered in localStorage); friends greet when one walks past, and
  // get a special handshake when they hang out.
  const FRIENDS_KEY = "pixel-crew:friends";
  const collabCounts: Record<string, number> = (() => {
    try {
      return JSON.parse(localStorage.getItem(FRIENDS_KEY) ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  })();
  function pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }
  function noteCollab(key: string): void {
    collabCounts[key] = (collabCounts[key] ?? 0) + 1;
    try {
      localStorage.setItem(FRIENDS_KEY, JSON.stringify(collabCounts));
    } catch {
      // Storage full / disabled: friendships just won't survive a reload.
    }
  }
  function areFriends(a: string, b: string): boolean {
    return (collabCounts[pairKey(a, b)] ?? 0) >= 2;
  }

  const greetedAt = new Map<string, number>();
  let greetAccum = 0;
  function updateGreetings(dt: number): void {
    greetAccum += dt;
    if (greetAccum < 400) return;
    greetAccum = 0;
    for (const [walkerId, walker] of entries) {
      if (!walker.person.isMoving || walker.temporary || walker.transition !== "ready") continue;
      for (const [otherId, other] of entries) {
        if (other === walker || other.temporary || other.person.isMoving || other.transition !== "ready") continue;
        if (Math.abs(other.person.x - walker.person.x) > 14 || Math.abs(other.person.y - walker.person.y) > 10) continue;
        if (!areFriends(walkerId, otherId)) continue;
        const key = pairKey(walkerId, otherId);
        if (elapsed - (greetedAt.get(key) ?? -Infinity) < 60_000) continue;
        greetedAt.set(key, elapsed);
        // In passing: the one at their desk waves "HI", the walker answers with a heart.
        other.person.wave();
        other.person.emote("hi", 1_400);
        walker.person.emote("heart", 1_200);
      }
    }
  }

  // --- 9. Link to the server dropped / back (fxBus "connection").
  let linkUpAt = -Infinity; // performance.now() of the last reconnect
  /** Completed-step count per department mission last seen (missionCheer). */
  let missionSeen = new Map<string, number>();
  function setConnection(state: "down" | "up"): void {
    if (state === "down") {
      power.setDown();
      return;
    }
    linkUpAt = performance.now();
    if (!power.isDown) return;
    power.setUp();
    // Everyone wakes in the order the lights come back on, not all at once.
    for (const entry of entries.values()) entry.wakeAt = null;
  }

  function updatePower(): void {
    power.monitors.length = 0;
    power.sleepers.length = 0;
    if (!power.dark) return;
    for (const seat of homeSeats.values()) {
      power.monitors.push({ x: seat.x - 6, y: seat.deskBottom - 17, w: 12, h: 6 } satisfies Rect);
    }
    for (const entry of entries.values()) {
      if (entry.person.asleep && entry.transition !== "removing") power.sleepers.push({ x: entry.person.x, y: entry.person.y - 16 });
    }
  }

  // --- 10. Settings echoes (fxBus "system"): an icon pops on the back wall and the idle crew glances at it.
  function playSystem(kind: SystemCueKind): void {
    cues.play(kind, CUE_AT);
    const idlers: PersonEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.temporary || entry.transition !== "ready" || entry.person.asleep) continue;
      entry.glanceUntil = elapsed + 1_700;
      entry.glanceX = CUE_AT.x;
      if (entry.last?.activity === "idle" && !entry.person.isMoving) idlers.push(entry);
    }
    // A couple of them react a bit more.
    for (const entry of idlers.sort(() => Math.random() - 0.5).slice(0, 2)) {
      if (kind === "remote-on" || kind === "notify-on") entry.person.hop();
      if (kind === "notify-on") entry.person.emote("bang", 900);
    }
  }

  // --- 4. Drag and drop onto an NPC. The scene only highlights and reports;
  // the UI decides what to do with the drop (fxBus "drop-dispatch").
  let dragEntry: PersonEntry | null = null;
  let dragSeenAt = 0;
  const acceptsDrag = (dt: DataTransfer | null) => {
    const types = Array.from(dt?.types ?? []);
    return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
  };
  function hitEntry(clientX: number, clientY: number): { id: string; entry: PersonEntry } | null {
    const p = clientToWorld(clientX, clientY);
    let best: { id: string; entry: PersonEntry } | null = null;
    let bestD = Infinity;
    for (const [id, entry] of entries) {
      if (entry.temporary || entry.transition !== "ready") continue;
      const dx = p.x - entry.person.x;
      const dy = p.y - entry.person.y;
      if (Math.abs(dx) > 9 || dy < -21 || dy > 4) continue;
      const d = Math.hypot(dx, dy + 9);
      if (d < bestD) {
        bestD = d;
        best = { id, entry };
      }
    }
    return best;
  }
  /**
   * Point the drag at an NPC (or nothing). While an NPC is targeted the canvas
   * claims file drags via data-file-drop-owner, so the app-wide "drop anywhere
   * to attach" handler steps aside; a synthetic dragenter lets that handler
   * re-read ownership and hide/show its full-screen overlay accordingly.
   */
  function setDragEntry(next: PersonEntry | null, event: DragEvent | null): void {
    if (next === dragEntry) return;
    if (dragEntry) dragEntry.person.reaching = false;
    dragEntry = next;
    if (next) next.person.reaching = true;
    if (next) app.canvas.dataset.fileDropOwner = "office-npc";
    else delete app.canvas.dataset.fileDropOwner;
    if (event?.dataTransfer && dragContainsFiles(event.dataTransfer)) {
      app.canvas.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: event.dataTransfer }));
    }
  }
  const onDragEnter = (event: DragEvent) => {
    if (!event.isTrusted || !acceptsDrag(event.dataTransfer)) return;
    if (hitEntry(event.clientX, event.clientY)) event.preventDefault();
  };
  const onDragOver = (event: DragEvent) => {
    if (!acceptsDrag(event.dataTransfer)) return;
    const hit = hitEntry(event.clientX, event.clientY);
    dragSeenAt = performance.now();
    setDragEntry(hit?.entry ?? null, event);
    if (hit) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  };
  const onDragLeave = (event: DragEvent) => {
    if (!event.isTrusted) return;
    if (event.relatedTarget instanceof Node && app.canvas.contains(event.relatedTarget)) return;
    setDragEntry(null, event);
  };
  const onDrop = (event: DragEvent) => {
    const hit = acceptsDrag(event.dataTransfer) ? hitEntry(event.clientX, event.clientY) : null;
    if (!hit || !event.dataTransfer) {
      setDragEntry(null, null);
      return;
    }
    event.preventDefault();
    const dt = event.dataTransfer;
    const text = dt.getData("text/plain") || dt.getData("text/uri-list") || "";
    const files = Array.from(dt.files ?? []);
    // Release the drop-owner flag only after the window-level handler has seen
    // (and skipped) this same drop event — otherwise it would attach it too.
    if (dragEntry) dragEntry.person.reaching = false;
    dragEntry = null;
    setTimeout(() => {
      if (!dragEntry) delete app.canvas.dataset.fileDropOwner;
    }, 0);
    hit.entry.person.catchIt();
    particles.burst(hit.entry.person.x, hit.entry.person.y - 10, CYAN, 8, 0.03);
    if (text || files.length > 0) emitFx({ type: "drop-dispatch", workerId: hit.entry.selectId, text, files });
  };
  app.canvas.addEventListener("dragenter", onDragEnter);
  app.canvas.addEventListener("dragover", onDragOver);
  app.canvas.addEventListener("dragleave", onDragLeave);
  app.canvas.addEventListener("drop", onDrop);
  function updateDragTimeout(): void {
    // An aborted drag (Esc, left the window) may never send dragleave to us.
    if (dragEntry && performance.now() - dragSeenAt > 500) setDragEntry(null, null);
  }

  // --- 7. Idle NPCs glance toward a nearby mouse cursor (mouse only).
  let cursor: Pt | null = null;
  const onCanvasPointerMove = (event: PointerEvent) => {
    cursor = event.pointerType === "mouse" ? clientToWorld(event.clientX, event.clientY) : null;
  };
  const onCanvasPointerLeave = () => {
    cursor = null;
  };
  app.canvas.addEventListener("pointermove", onCanvasPointerMove);
  app.canvas.addEventListener("pointerleave", onCanvasPointerLeave);
  function gazeFor(entry: PersonEntry): -1 | 0 | 1 {
    if (entry.glanceUntil > elapsed) {
      const dx = entry.glanceX - entry.person.x;
      return Math.abs(dx) < 4 ? 0 : dx < 0 ? -1 : 1;
    }
    if (!cursor || entry.temporary) return 0;
    const dx = cursor.x - entry.person.x;
    const dy = cursor.y - (entry.person.y - 12);
    if (Math.abs(dx) > 70 || Math.abs(dy) > 50 || Math.abs(dx) < 3) return 0;
    return dx < 0 ? -1 : 1;
  }

  // --- 5. Collaboration links + sub-agent summon beams.
  function parentOf(w: WorkerSceneState): string | null {
    if (w.parentId) return w.parentId;
    const cut = w.id.indexOf(":subagent:");
    return cut > 0 ? w.id.slice(0, cut) : null;
  }

  // Collaborators now and then fling a document across to each other.
  let collabPairs: Array<[string, string]> = [];
  let docAccum = 0;
  function updateCollabDocs(dt: number): void {
    if (collabPairs.length === 0 || REDUCE_MOTION_SCENE) return;
    docAccum += dt;
    if (docAccum < 7_000) return;
    docAccum = 0;
    const [a, b] = collabPairs[Math.floor(Math.random() * collabPairs.length)];
    const [from, to] = Math.random() < 0.5 ? [a, b] : [b, a];
    const src = chestOf(from)();
    if (!src) return;
    fx.plane(src, chestOf(to), () => entries.get(to)?.person.catchIt());
  }

  function syncLinks(list: WorkerSceneState[]): void {
    const links: LinkSpec[] = [];
    const before = new Set(collabPairs.map(([a, b]) => pairKey(a, b)));
    collabPairs = list
      .filter((w) => w.collaborationRole === "source" && w.collaborationPartnerId && entries.has(w.collaborationPartnerId))
      .map((w) => [w.id, w.collaborationPartnerId!] as [string, string]);
    // Every new collaboration between the same two adds to their friendship.
    for (const [a, b] of collabPairs) {
      const key = pairKey(a, b);
      if (!before.has(key)) noteCollab(key);
    }
    for (const w of list) {
      if (w.collaborationRole === "source" && w.collaborationPartnerId && entries.has(w.collaborationPartnerId)) {
        const returning = w.collaborationPhase === "returning";
        links.push({
          key: `${w.id}>${w.collaborationPartnerId}`,
          // Work goes out to the collaborator; results come back when returning.
          from: chestOf(returning ? w.collaborationPartnerId : w.id),
          to: chestOf(returning ? w.id : w.collaborationPartnerId),
          color: returning ? GREEN : CYAN,
        });
      }
      const parent = w.temporary ? parentOf(w) : null;
      if (parent && entries.has(parent) && links.length < 12) {
        links.push({ key: `${parent}~${w.id}`, from: chestOf(parent), to: chestOf(w.id), color: 0xb59cff });
      }
    }
    fx.setLinks(links);
  }

  // --- Sub-agent portals: step out of one on arrival, walk back into one on exit.
  const SUMMON_MS = 950;
  function portalSpot(near: Pt, side: number): Pt {
    return {
      x: Math.max(10, Math.min(ART_W - 10, near.x + side * 11)),
      y: Math.max(56, Math.min(floorH - 6, near.y + 3)),
    };
  }

  function updateSummon(entry: PersonEntry): void {
    const t = entry.transitionMs;
    const c = entry.person.container;
    const k = Math.max(0, Math.min(1, (t - 200) / 300));
    c.scale.set(0.3 + 0.7 * k);
    c.alpha = entry.baseAlpha * k;
    if (t >= 420 && entry.shrinkAt === null) {
      entry.shrinkAt = -1; // marker: the walk-out has started
      entry.person.setTarget(entry.targetX, entry.targetY);
    }
    if (t >= SUMMON_MS) {
      // Reporting for duty: the sub-agent waves at whoever summoned it, who acknowledges.
      entry.person.wave();
      if (entry.parentId) entries.get(entry.parentId)?.person.emote("bang", 700);
      entry.portal?.close();
      entry.portal = null;
      entry.shrinkAt = null;
      c.scale.set(1);
      c.alpha = entry.baseAlpha;
      entry.transition = "ready";
    }
  }

  /** Returns true once the sub-agent has vanished and can be destroyed. */
  function updateDismiss(entry: PersonEntry): boolean {
    const c = entry.person.container;
    if (entry.shrinkAt === null) {
      if (entry.person.isMoving && entry.transitionMs < 1_400) return false;
      entry.shrinkAt = entry.transitionMs;
    }
    const k = Math.min(1, (entry.transitionMs - entry.shrinkAt) / 320);
    c.scale.set(1 - 0.75 * k);
    c.alpha = entry.baseAlpha * (1 - k);
    if (k < 1) return false;
    entry.portal?.close();
    entry.portal = null;
    return true;
  }

  const offFx = onFx((event) => {
    if (event.type === "dispatch") playDispatch(event.workerId, clientToWorld(event.from.x, event.from.y));
    else if (event.type === "deliverable") queueDelivery(event.workerId);
    else if (event.type === "connection") setConnection(event.state);
    else if (event.type === "system") playSystem(event.kind);
  });

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS;
    elapsed += dt;

    room.update(elapsed);
    furniture.update(elapsed);
    personalDesks.update(dt);
    particles.update(dt);
    updateSocial(dt);
    cat.update(elapsed, dt);
    officeDecor.update(dt);
    hotspots.update();
    ripples.update(dt);
    fx.update(dt);
    shelf.update(dt);
    updateDeliveries(dt);
    updateFatigue(dt);
    updateDragTimeout();
    updateChores(dt);
    updateRare(dt);
    updateTalk(dt);
    updateGreetings(dt);
    updateCollabDocs(dt);
    party.update(dt);
    updatePower();
    power.update(dt);
    cues.update(dt);

    // 日夜循環：每 30 秒對一次真實時間（跨過清晨/黃昏的分界時色調就會換）。
    daylightAccum += dt;
    if (daylightAccum >= 30_000) {
      daylightAccum = 0;
      applyDaylight();
    }

    // 閒置生命感：每 9~18 秒隨機挑一位「沒在忙」的常駐 NPC，冒個小表情——
    // 喝咖啡、跟旁邊的人聊兩句、偶爾靈光一閃。讓辦公室像有人味的地方，
    // 而不是一排等待指令的雕像。忙碌中/等核准/正在冒表情的人不打擾。
    idleEmoteAccum += dt;
    if (idleEmoteAccum >= idleEmoteNext) {
      idleEmoteAccum = 0;
      idleEmoteNext = 9_000 + Math.random() * 9_000;
      const idlers = [...entries.values()].filter((entry) =>
        entry.transition === "ready" && !entry.temporary && !entry.waiting &&
        entry.last !== null && entry.last.activity !== "working" && entry.last.activity !== "thinking" &&
        entry.person.emoting === null && entry.person.acting === null && !entry.person.asleep,
      );
      if (idlers.length > 0) {
        const pick = idlers[Math.floor(Math.random() * idlers.length)];
        // After 23:00 someone may hint it's bedtime.
        const late = seasonal(officeNow()).lateNight && Math.random() < 0.35;
        const kind: EmoteKind = late ? "moon" : Math.random() < 0.15 ? "spark" : (Math.random() < 0.5 ? "coffee" : "chat");
        pick.person.emote(kind, 2_400);
      }
    }

    const positions: PersonScreenPos[] = [];
    for (const [id, entry] of entries) {
      entry.transitionMs += dt;
      if (entry.transition === "entering" && entry.temporary) {
        updateSummon(entry);
      } else if (entry.transition === "removing" && entry.temporary) {
        if (updateDismiss(entry)) {
          entry.person.destroy();
          entries.delete(id);
          continue;
        }
      } else if (entry.transition === "entering") {
        const progress = Math.min(1, entry.transitionMs / PERSON_ENTER_MS);
        // Let the desk finish assembling before its owner walks in. The late
        // fade only softens the doorway edge; movement remains the main cue.
        if (entry.transitionMs >= 720) entry.person.setTarget(entry.targetX, entry.targetY);
        entry.person.container.alpha = entry.baseAlpha * Math.min(1, Math.max(0, (progress - 0.48) / 0.22));
        if (progress >= 1) {
          entry.transition = "ready";
          entry.person.container.alpha = entry.baseAlpha;
        }
      } else if (entry.transition === "removing" && entry.farewell) {
        // Waves goodbye at their desk, then vanishes in a puff of smoke.
        if (entry.person.farewellDone || entry.transitionMs > 3_000) {
          particles.burst(entry.person.x, entry.person.y - 8, 0xc4ccdc, 10, 0.03);
          entry.person.destroy();
          entries.delete(id);
          continue;
        }
      } else if (entry.transition === "removing") {
        const progress = Math.min(1, entry.transitionMs / PERSON_EXIT_MS);
        entry.person.container.alpha = entry.baseAlpha * (progress < 0.42
          ? 1
          : Math.max(0, 1 - (progress - 0.42) / 0.58));
        if (progress >= 1) {
          entry.person.destroy();
          entries.delete(id);
          continue;
        }
      }
      const raising = entry.waiting && entry.transition === "ready" && !entry.temporary;
      entry.person.handRaised = raising;
      // Waiting on the owner for over a minute: foot tapping, watch checking.
      if (!raising) entry.waitingSince = null;
      else if (entry.waitingSince === null) entry.waitingSince = elapsed;
      entry.person.impatient = raising && elapsed - (entry.waitingSince ?? elapsed) > 60_000;
      // Heavy context use shows: droopy, eye bags, slower steps.
      entry.person.tired = (entry.ctxPct ?? 0) >= 85;
      if (raising) {
        // Hand up, a pulsing amber "!", and a little "pick me" hop every
        // couple of seconds until the user resolves the approval.
        entry.person.emote("alert", 1_500);
        entry.hopIn -= dt;
        if (entry.hopIn <= 0 && !entry.person.isMoving) {
          entry.hopIn = 1_800;
          entry.person.hop();
        }
      } else {
        entry.hopIn = 600;
      }
      // Level of detail: NPCs outside the viewport aren't drawn (they still move and tick).
      const sx = world.position.x + entry.person.x * scale;
      const sy = world.position.y + entry.person.y * scale;
      const margin = 60 * scale;
      entry.person.container.visible = sx > -margin && sx < app.screen.width + margin && sy > -margin && sy < app.screen.height + margin * 0.6;
      entry.person.gaze = gazeFor(entry);
      // Power cut: everybody nods off; they wake once the light over them is back on.
      entry.person.snoreVisible = !power.dark;
      if (power.isDown) {
        if (entry.transition !== "removing") entry.person.asleep = true;
      } else if (entry.person.asleep && power.lit(entry.person.x, entry.person.y)) {
        if (entry.wakeAt === null) entry.wakeAt = elapsed + Math.random() * 450;
        else if (elapsed >= entry.wakeAt) {
          entry.wakeAt = null;
          entry.person.wake();
        }
      }

      // Long stretches of work: headphones on (after ~3 minutes).
      const busy = entry.last?.activity === "working" || entry.last?.activity === "thinking";
      if (!busy) entry.busySince = null;
      else if (entry.busySince === null) entry.busySince = elapsed;
      entry.person.deepFocus = busy && elapsed - (entry.busySince ?? elapsed) > 180_000;

      entry.person.update(elapsed, dt);

      const state = entry.last;
      if (
        state?.activity === "working" &&
        !entry.person.isMoving &&
        Math.random() < 0.12
      ) {
        const def = furniture.def(state.station);
        particles.rise(
          def.x + (Math.random() - 0.5) * def.map[0].length * 0.6,
          def.bottom - def.map.length * 0.7,
          CYAN,
          4,
        );
      }

      positions.push({
        id,
        x: world.position.x + entry.person.x * scale,
        y: world.position.y + (entry.person.y - 17) * scale,
        scale,
        opacity: entry.person.container.alpha,
      });
    }
    callbacks.onPositions(positions);
  });

  return {
    setWorkers(list: WorkerSceneState[]) {
      const permanentWorkers = list.filter((worker) => !worker.temporary);
      const deskLayout = personalDesks.setWorkers(permanentWorkers);
      homeSeats = deskLayout.seats;
      power.lamps = officeLamps(deskLayout.departments);
      if (deskLayout.floorHeight !== floorH) {
        floorH = deskLayout.floorHeight;
        room.setFloorHeight(floorH);
        power.setArea({ x: 0, y: 0, w: ART_W, h: floorH });
        party.setArea({ x: 0, y: 0, w: ART_W, h: floorH });
        applyView();
      }
      // 圓桌進行時（有 NPC 站到 meeting 會議桌），強制顯示會議桌，即使目前人數 >4。
      officeDecor.setWorkerCount(permanentWorkers.length, list.some((w) => w.character.station === "meeting"));
      // Department mission step done → the team thumbs up; last step → everyone cheers.
      const missionDiff = missionCheers(missionSeen, list);
      missionSeen = missionDiff.seen;
      if (!power.dark && performance.now() - linkUpAt >= 2_500) {
        for (const cheer of missionDiff.cheers) {
          for (const id of cheer.ids) {
            const member = entries.get(id);
            if (!member || member.transition !== "ready" || member.person.asleep) continue;
            if (REDUCE_MOTION_SCENE) member.person.emote(cheer.kind === "done" ? "spark" : "thumb", 1_500);
            else if (cheer.kind === "step") member.person.thumbsUp();
            else {
              member.person.cheer();
              member.person.emote("spark", 1_800);
              particles.burst(member.person.x, member.person.y - 17, GOLD, 8, 0.035);
            }
          }
        }
      }
      // Crew diff. Only a worker that is genuinely new — the list has been
      // stable for a few seconds, the link isn't down / just back, and it's
      // one or two people rather than a whole re-snapshot — beams in; same
      // gate for a farewell. Everything else keeps the quiet walk in / out.
      const crewNow = performance.now();
      if (crewBaselineAt === null && permanentWorkers.length > 0) crewBaselineAt = crewNow;
      const crewSettled = crewBaselineAt !== null && crewNow - crewBaselineAt >= CREW_SETTLE_MS &&
        !power.dark && crewNow - linkUpAt >= CREW_SETTLE_MS;
      const unseen = permanentWorkers.filter((w) => !knownIds.has(w.id));
      const arrivals = crewSettled && unseen.length <= MAX_ARRIVALS ? new Set(unseen.map((w) => w.id)) : new Set<string>();
      for (const w of permanentWorkers) knownIds.add(w.id);
      const listed = new Set(list.map((w) => w.id));
      let leaving = 0;
      for (const [id, entry] of entries) if (!entry.temporary && entry.transition !== "removing" && !listed.has(id)) leaving++;
      const farewells = crewSettled && leaving <= MAX_DEPARTURES && permanentWorkers.length > 0;

      const seen = new Set<string>();
      let permanentIndex = 0;
      let temporaryIndex = 0;
      // 會議桌座位要跨「常駐（作戰室成員）／臨時（子代理）」兩類共用一條序號——兩類各自從 0
      // 起算的話，兩邊的 0 號都會坐到 MEETING_SEATS[0]，精靈完全疊在同一格。
      let meetingIndex = 0;
      for (const w of list) {
        const workerIndex = w.temporary ? temporaryIndex++ : permanentIndex++;
        const spotIndex = w.character.station === "meeting" ? meetingIndex++ : workerIndex;
        seen.add(w.id);
        let entry = entries.get(w.id);
        const desiredSpot = standSpot(w.character.station, spotIndex, w.id);
        if (!entry) {
          const person = new Person(w.colorIndex);
          person.trait = traitFor(w.id);
          const look = hashId(w.id);
          person.accessory = ACCESSORIES[(look >>> 8) % ACCESSORIES.length];
          person.accessoryColor = [0xff5d73, 0x4de3ff, 0xffd166, 0x37d6a3, 0x9b7bff, 0xf29e4c, 0xff8fc8][(look >>> 16) % 7];
          person.sunglasses = sessionFlag(`shades:${w.id}`);
          person.container.eventMode = "static";
          person.container.cursor = "pointer";
          person.container.hitArea = {
            contains: (x: number, y: number) => x >= -8 && x <= 8 && y >= -18 && y <= 2,
          };
          // Select on a genuine tap, not on pointerdown — otherwise beginning a
          // pan/swipe on top of an NPC instantly selected it (which opens the task
          // log). isDragging() is the shared Pixi-native pan check (see above).
          let ppid = -1;
          person.container.on("pointerdown", (event) => { ppid = event.pointerId; });
          person.container.on("pointerup", (event) => {
            if (event.pointerId !== ppid) return;
            ppid = -1;
            if (isDragging()) return;
            const poked = entries.get(w.id);
            if (poked) pokeEntry(poked);
            // Alt+click is a poke only (no selection); a plain click selects as before and gets a reaction too.
            if (event.altKey) return;
            callbacks.onSelect(w.selectId);
            // A hand-raising NPC also opens its pending approval (UI decides how).
            const current = entries.get(w.id);
            if (current?.waiting) emitFx({ type: "open-approval", workerId: w.selectId });
          });
          person.container.on("pointertap", (event) => {
            if (event.detail >= 2) callbacks.onOpen(w.selectId);
          });
          person.container.on("rightclick", (event) => {
            event.preventDefault();
            callbacks.onContextMenu?.(w.selectId);
          });
          person.container.on("pointerover", (event) => {
            overInteractive = true;
            if (event.pointerType !== "touch") person.hovered = true;
            // Touch has no hover: a finger panning past an NPC — even one sitting
            // behind the task-log sheet, reached via the canvas's implicit pointer
            // capture — fired its card mid-swipe. Mouse hovers show the card; touch
            // users tap (pointertap above) to open the NPC instead.
            if (event.pointerType !== "touch") callbacks.onHover(w.temporary ? null : w.id);
            // An idle NPC waves back at the mouse (rate-limited inside Person).
            const current = entries.get(w.id);
            if (event.pointerType === "mouse" && current && !current.temporary && !current.waiting &&
              current.transition === "ready" && current.last?.activity === "idle" && !current.person.isMoving) {
              current.person.wave();
            }
          });
          person.container.on("pointerout", (event) => {
            overInteractive = false;
            person.hovered = false;
            if (event.pointerType !== "touch") callbacks.onHover(null);
          });
          world.addChild(person.container);
          // A genuinely new teammate beams straight in at their seat.
          const beamIn = arrivals.has(w.id);
          const entering = !w.temporary && !beamIn;
          // Sub-agents step out of a portal beside whoever summoned them.
          const parentEntry = w.temporary ? entries.get(parentOf(w) ?? "") : undefined;
          const summonFrom = parentEntry ?? null;
          const summon = w.temporary && !REDUCE_MOTION_SCENE;
          const spawn = summon
            ? portalSpot(summonFrom ? { x: summonFrom.person.x, y: summonFrom.person.y } : desiredSpot,
              (summonFrom ? summonFrom.person.x : desiredSpot.x) < ART_W / 2 ? 1 : -1)
            : null;
          entry = {
            person,
            last: null,
            index: workerIndex,
            avatarId: null,
            avatarKind: "preset",
            avatarPresetId: "classic",
            temporary: w.temporary,
            transition: entering || summon ? "entering" : "ready",
            transitionMs: 0,
            baseAlpha: w.temporary ? 0.88 : 1,
            targetX: desiredSpot.x,
            targetY: desiredSpot.y,
            waiting: false,
            selectId: w.selectId,
            hopIn: 600,
            strolling: false,
            lastSuccessAt: 0,
            lastHaloAt: 0,
            ctxPct: null,
            parentId: parentOf(w),
            portal: null,
            shrinkAt: null,
            farewell: false,
            wakeAt: null,
            glanceUntil: 0,
            glanceX: 0,
            pokes: [],
            pokeTotal: 0,
            busySince: null,
            errors: [],
            chain: 0,
            waitingSince: null,
          };
          entries.set(w.id, entry);
          if (beamIn) {
            person.arrive();
            for (let i = 0; i < 6; i++) particles.rise(desiredSpot.x, desiredSpot.y - 4, CYAN, 12);
          }
          person.x = spawn ? spawn.x : desiredSpot.x;
          person.y = spawn ? spawn.y : entering ? floorH + 8 : desiredSpot.y;
          person.setTarget(person.x, person.y);
          person.container.alpha = entering || spawn ? 0 : entry.baseAlpha;
          if (spawn) {
            entry.portal = fx.openPortal(spawn.x, spawn.y);
            person.container.scale.set(0.3);
            if (summonFrom) fx.beam(chestOf(parentOf(w)!), () => ({ x: spawn.x, y: spawn.y - 9 }));
          }
        } else if (entry.transition === "removing") {
          entry.transition = w.temporary ? "ready" : "entering";
          entry.transitionMs = 0;
          entry.person.container.eventMode = "static";
          if (entry.farewell) {
            // Changed their mind mid-goodbye: beam right back in.
            entry.farewell = false;
            entry.transition = "ready";
            entry.person.arrive();
          }
          if (w.temporary) {
            // Called back before vanishing: step out of the portal again.
            entry.portal?.close();
            entry.portal = null;
            entry.shrinkAt = null;
            entry.person.container.scale.set(1);
            entry.person.container.alpha = entry.baseAlpha;
            entry.person.setTarget(desiredSpot.x, desiredSpot.y);
          }
        }
        entry.index = workerIndex;
        entry.targetX = desiredSpot.x;
        entry.targetY = desiredSpot.y;
        if (entry.avatarId !== w.avatarId || entry.avatarKind !== w.avatarKind || entry.avatarPresetId !== w.avatarPresetId) {
          entry.avatarId = w.avatarId;
          entry.avatarKind = w.avatarKind;
          entry.avatarPresetId = w.avatarPresetId;
          entry.person.setPreset(w.avatarPresetId, w.colorIndex);
          void entry.person
            .setAvatar(w.avatarKind === "custom" && w.avatarId ? apiAssetUrl(`/api/avatars/${w.avatarId}`) : null)
            .then((message) => {
              if (message) callbacks.onAvatarError(w.selectId, message);
            });
        }
        entry.person.active = w.active;
        entry.waiting = w.waiting;
        entry.ctxPct = w.ctxPct ?? null;
        if (!w.waiting && entry.person.emoting === "alert") entry.person.emote("alert", 0);
        if (entry.last !== w.character) applyCharacter(entry, w.character, w.id);
        // home 會持續回座位；meeting（作戰室圍桌）也要持續把 NPC 拉到會議桌邊——否則非 home 站點
        // 只有在「station 剛改變且已 ready」那一瞬間才會移動，剛建立的 NPC 還在 entering、錯過那瞬間
        // 就永遠不會走過去（這就是先前「沒有過去」的原因）。
        if (entry.transition === "ready" && !entry.strolling && (w.character.station === "home" || w.character.station === "meeting")) {
          entry.person.setTarget(desiredSpot.x, desiredSpot.y);
        }
      }
      for (const [id, entry] of entries) {
        if (!seen.has(id)) {
          if (entry.transition !== "removing") {
            entry.transition = "removing";
            entry.transitionMs = 0;
            entry.person.active = false;
            entry.person.container.eventMode = "none";
            callbacks.onHover(null);
            if (entry.temporary && !REDUCE_MOTION_SCENE) {
              // Walk back into a portal that opens right beside them.
              const side = entry.person.x < ART_W / 2 ? -1 : 1;
              const spot = portalSpot({ x: entry.person.x, y: entry.person.y - 3 }, side);
              entry.portal?.close();
              entry.portal = fx.openPortal(spot.x, spot.y);
              entry.shrinkAt = null;
              entry.person.setTarget(spot.x, spot.y);
            } else if (entry.temporary) {
              entry.shrinkAt = 0;
            } else if (farewells && !entry.person.isMoving) {
              entry.farewell = true;
              entry.person.farewell();
            } else {
              entry.person.setTarget(entry.person.x, floorH + 8);
            }
            if (delivery?.entry === entry) endDelivery(false);
          }
        }
      }

      const activeStations = new Set<StationKey>();
      for (const w of list) {
        if (!w.temporary && w.character.activity === "working") activeStations.add(w.character.station);
      }
      furniture.setActive(activeStations);
      syncLinks(list);
    },
    resize() {
      app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
      // Renderer dimensions may already match immediately after Pixi init,
      // so guarantee the browser-width camera fit is applied.
      layout();
    },
    setZoom(nextScale: number) {
      zoomAnchored(nextScale, app.screen.width / 2, app.screen.height / 2);
    },
    resetView,
    setMilestone(level: number) {
      officeDecor.setMilestone(level);
    },
    brainReset,
    destroy() {
      offFx();
      app.canvas.removeEventListener("dragenter", onDragEnter);
      app.canvas.removeEventListener("dragover", onDragOver);
      app.canvas.removeEventListener("dragleave", onDragLeave);
      app.canvas.removeEventListener("drop", onDrop);
      app.canvas.removeEventListener("pointermove", onCanvasPointerMove);
      app.canvas.removeEventListener("pointerleave", onCanvasPointerLeave);
      fx.destroy();
      power.destroy();
      cues.destroy();
      hotspots.destroy();
      offKonami();
      party.destroy();
      ripples.destroy();
      app.renderer.off("resize", layout);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      for (const entry of entries.values()) entry.person.destroy();
      entries.clear();
      app.destroy(true, { children: true, texture: true });
    },
  };
}
