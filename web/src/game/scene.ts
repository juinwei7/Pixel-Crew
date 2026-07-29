// Pixi generates some of its render code with `new Function(...)` at runtime.
// Our server sends a strict CSP (`script-src 'self'`, no `unsafe-eval`), which
// blocks that and throws "Current environment does not allow unsafe-eval"
// before a single frame renders. This official polyfill module patches Pixi
// to use precompiled fallbacks instead, so it works under strict CSP without
// loosening it. Must be imported before the first `Application` is created.
import "pixi.js/unsafe-eval";
import { Application, Container, Text } from "pixi.js";
import type { CharacterState } from "../types";
import type { StationKey } from "../stations";
import { Room, ART_W, ART_H } from "./room";
import { FurnitureLayer, FURNITURE_DEFS } from "./furniture";
import { Person } from "./person";
import { ParticleSystem } from "./particles";
import { PersonalDeskLayer } from "./personalDesks";
import type { DepartmentPhase, DepartmentSeat } from "./personalDesks";
import { OfficeDecor } from "./officeDecor";
import { Cat } from "./cat";
import { apiAssetUrl } from "../api";
import { responsiveOfficeFitScale } from "./camera";

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
  /** True while a tool-call approval is waiting on the user. */
  waiting: boolean;
  workspacePath: string;
  departmentKey?: string;
  workspaceLabel: string;
  collaborationPhase: DepartmentPhase;
  collaborationRole: "source" | "target" | null;
  missionProgress?: { completed: number; total: number } | null;
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
  paceT: number;
  paceDir: number;
  /** True while this NPC is off on a social stroll — home re-targeting pauses. */
  strolling: boolean;
};

const PERSON_ENTER_MS = 1_350;
const PERSON_EXIT_MS = 780;

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
  );
  const officeDecor = new OfficeDecor();
  const cat = new Cat();

  room.container.zIndex = -1000;
  particles.g.zIndex = 10000;
  world.addChild(room.container, personalDesks.container, officeDecor.container, particles.g, cat.container);
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

  let scale = 1;
  let fitScale = 2;
  // User camera: null scale = auto-fit; pan offsets are relative to the
  // centered position, clamped so the room can never be dragged fully
  // off-screen. Double-click on empty floor resets everything.
  let userScale: number | null = null;
  let panX = 0;
  let panY = 0;

  function applyView(): void {
    const w = app.screen.width;
    const h = app.screen.height;
    scale = Math.max(2, Math.min(userScale ?? fitScale, fitScale + 4));
    world.scale.set(scale);
    const baseX = Math.floor((w - ART_W * scale) / 2);
    const baseY = Math.floor((h - ART_H * scale) / 2);
    const keep = 140;
    panX = Math.min(w - keep - baseX, Math.max(keep - (baseX + ART_W * scale), panX));
    panY = Math.min(h - keep - baseY, Math.max(keep - (baseY + ART_H * scale), panY));
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
      minScale: 2,
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

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragId = event.pointerId;
    dragPanning = false;
    dragStartX = dragLastX = event.clientX;
    dragStartY = dragLastY = event.clientY;
  };
  const onPointerMove = (event: PointerEvent) => {
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
    if (dragId === event.pointerId) dragId = null;
  };
  // Continuous, not stepped to integers — smooth zoom in/out at any size,
  // only clamped at the min/max bounds.
  function zoomAnchored(next: number, cx: number, cy: number): void {
    const clamped = Math.max(2, Math.min(fitScale + 4, next));
    if (clamped === scale) return;
    const wx = (cx - world.position.x) / scale;
    const wy = (cy - world.position.y) / scale;
    userScale = clamped;
    panX = cx - wx * clamped - Math.floor((app.screen.width - ART_W * clamped) / 2);
    panY = cy - wy * clamped - Math.floor((app.screen.height - ART_H * clamped) / 2);
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
  app.canvas.addEventListener("wheel", onWheel, { passive: false });
  app.canvas.addEventListener("dblclick", onDoubleClick);

  const entries = new Map<string, PersonEntry>();
  // Seats depend on the whole crew's department packing, not the worker's
  // index alone — refreshed from the desk layout on every setWorkers.
  let homeSeats = new Map<string, DepartmentSeat>();
  let elapsed = 0;

  // --- Idle social: occasionally one idle NPC strolls over to another for a
  // short coffee chat, then walks home. Purely visual; aborts the moment
  // either participant gets real work.
  type Social = {
    stage: "walking" | "chatting" | "returning";
    visitor: PersonEntry;
    host: PersonEntry;
    chatMs: number;
  };
  let social: Social | null = null;
  let socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);

  function socialEligible(entry: PersonEntry): boolean {
    return entry.transition === "ready" && !entry.temporary && !entry.waiting &&
      entry.last?.station === "home" && entry.last.activity !== "working" && entry.last.activity !== "thinking";
  }

  function endSocial(): void {
    if (!social) return;
    social.visitor.person.emote("coffee", 0);
    social.host.person.emote("chat", 0);
    social.visitor.strolling = false;
    social.visitor.person.setTarget(social.visitor.targetX, social.visitor.targetY);
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
        if (!visitor.person.isMoving) {
          social.stage = "chatting";
          social.chatMs = 4_000;
        }
      } else if (social.stage === "chatting") {
        visitor.person.emote("coffee", 600);
        host.person.emote("chat", 600);
        social.chatMs -= dt;
        if (social.chatMs <= 0) {
          social.stage = "returning";
          visitor.person.emote("coffee", 0);
          host.person.emote("chat", 0);
          visitor.person.setTarget(visitor.targetX, visitor.targetY);
        }
      } else if (!visitor.person.isMoving) {
        visitor.strolling = false;
        social = null;
        socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);
      }
      return;
    }
    socialCooldown -= dt;
    if (socialCooldown > 0) return;
    socialCooldown = 25_000 + Math.floor(Math.random() * 20_000);
    const idle = [...entries.values()].filter(socialEligible);
    if (idle.length < 2) return;
    const visitor = idle[Math.floor(Math.random() * idle.length)];
    const others = idle.filter((entry) => entry !== visitor);
    const host = others[Math.floor(Math.random() * others.length)];
    visitor.strolling = true;
    const side = visitor.person.x <= host.person.x ? -1 : 1;
    visitor.person.setTarget(
      Math.max(8, Math.min(ART_W - 8, host.person.x + side * 12)),
      Math.max(52, Math.min(ART_H - 6, host.person.y + 2)),
    );
    social = { stage: "walking", visitor, host, chatMs: 0 };
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
    const [ox, oy] = SPOT_OFFSETS[index % SPOT_OFFSETS.length];
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
    }
    person.activity = next.activity;

    if (prev && next.bump !== prev.bump && next.mood !== "neutral") {
      const success = next.mood === "success";
      person.flash(success ? GREEN : RED, success);
      particles.burst(person.x, person.y - 8, success ? GREEN : RED, success ? 14 : 18, 0.045);
      if (success) {
        // Nearby colleagues turn and applaud.
        for (const other of entries.values()) {
          if (other === entry || other.temporary || other.transition !== "ready") continue;
          if (Math.hypot(other.person.x - person.x, other.person.y - person.y) <= 60) other.person.cheer();
        }
      } else {
        person.emote("cloud", 4_000);
      }
    }
  }

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS;
    elapsed += dt;

    room.update(elapsed);
    furniture.update(elapsed);
    personalDesks.update(dt);
    particles.update(dt);
    updateSocial(dt);
    cat.update(elapsed, dt);

    const positions: PersonScreenPos[] = [];
    for (const [id, entry] of entries) {
      entry.transitionMs += dt;
      if (entry.transition === "entering") {
        const progress = Math.min(1, entry.transitionMs / PERSON_ENTER_MS);
        // Let the desk finish assembling before its owner walks in. The late
        // fade only softens the doorway edge; movement remains the main cue.
        if (entry.transitionMs >= 720) entry.person.setTarget(entry.targetX, entry.targetY);
        entry.person.container.alpha = entry.baseAlpha * Math.min(1, Math.max(0, (progress - 0.48) / 0.22));
        if (progress >= 1) {
          entry.transition = "ready";
          entry.person.container.alpha = entry.baseAlpha;
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
      if (entry.waiting && entry.transition === "ready" && !entry.temporary) {
        // Keep the "?" bubble alive and pace nervously around the spot until
        // the user resolves the approval.
        entry.person.emote("question", 1_500);
        entry.paceT += dt;
        if (entry.paceT >= 1_400 && !entry.person.isMoving) {
          entry.paceT = 0;
          entry.paceDir = -entry.paceDir;
          entry.person.setTarget(
            Math.max(8, Math.min(ART_W - 8, entry.targetX + entry.paceDir * 6)),
            entry.targetY,
          );
        }
      } else if (entry.paceT !== 0) {
        entry.paceT = 0;
      }

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
      homeSeats = personalDesks.setWorkers(permanentWorkers).seats;
      officeDecor.setWorkerCount(permanentWorkers.length);
      const seen = new Set<string>();
      let permanentIndex = 0;
      let temporaryIndex = 0;
      for (const w of list) {
        const workerIndex = w.temporary ? temporaryIndex++ : permanentIndex++;
        seen.add(w.id);
        let entry = entries.get(w.id);
        const desiredSpot = standSpot(w.character.station, workerIndex, w.id);
        if (!entry) {
          const person = new Person(w.colorIndex);
          person.container.eventMode = "static";
          person.container.cursor = "pointer";
          person.container.hitArea = {
            contains: (x: number, y: number) => x >= -8 && x <= 8 && y >= -18 && y <= 2,
          };
          person.container.on("pointerdown", () => callbacks.onSelect(w.selectId));
          person.container.on("pointertap", (event) => {
            if (event.detail >= 2) callbacks.onOpen(w.selectId);
          });
          person.container.on("rightclick", (event) => {
            event.preventDefault();
            callbacks.onContextMenu?.(w.selectId);
          });
          person.container.on("pointerover", () => {
            overInteractive = true;
            callbacks.onHover(w.temporary ? null : w.id);
          });
          person.container.on("pointerout", () => {
            overInteractive = false;
            callbacks.onHover(null);
          });
          world.addChild(person.container);
          const entering = !w.temporary;
          entry = {
            person,
            last: null,
            index: workerIndex,
            avatarId: null,
            avatarKind: "preset",
            avatarPresetId: "classic",
            temporary: w.temporary,
            transition: entering ? "entering" : "ready",
            transitionMs: 0,
            baseAlpha: w.temporary ? 0.88 : 1,
            targetX: desiredSpot.x,
            targetY: desiredSpot.y,
            waiting: false,
            paceT: 0,
            paceDir: 1,
            strolling: false,
          };
          entries.set(w.id, entry);
          person.x = desiredSpot.x;
          person.y = entering ? ART_H + 8 : desiredSpot.y;
          person.setTarget(person.x, person.y);
          person.container.alpha = entering ? 0 : entry.baseAlpha;
        } else if (entry.transition === "removing") {
          entry.transition = w.temporary ? "ready" : "entering";
          entry.transitionMs = 0;
          entry.person.container.eventMode = "static";
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
        if (!w.waiting && entry.person.emoting === "question") entry.person.emote("question", 0);
        if (entry.last !== w.character) applyCharacter(entry, w.character, w.id);
        if (entry.transition === "ready" && w.character.station === "home" && !entry.strolling) {
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
            entry.person.setTarget(entry.person.x, ART_H + 8);
          }
        }
      }

      const activeStations = new Set<StationKey>();
      for (const w of list) {
        if (!w.temporary && w.character.activity === "working") activeStations.add(w.character.station);
      }
      furniture.setActive(activeStations);
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
    destroy() {
      app.renderer.off("resize", layout);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      for (const entry of entries.values()) entry.person.destroy();
      entries.clear();
      app.destroy(true, { children: true, texture: true });
    },
  };
}
