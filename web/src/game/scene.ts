import { Application, Container, Text } from "pixi.js";
import type { CharacterState } from "../types";
import type { StationKey } from "../stations";
import { Room, ART_W, ART_H } from "./room";
import { FurnitureLayer, FURNITURE_DEFS } from "./furniture";
import { Person } from "./person";
import { ParticleSystem } from "./particles";
import { PersonalDeskLayer, personalDeskSpot } from "./personalDesks";
import { OfficeDecor } from "./officeDecor";
import { apiAssetUrl } from "../api";

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
  selectId: string;
  temporary: boolean;
};

export type PersonScreenPos = { id: string; x: number; y: number; scale: number };

export type SceneHandle = {
  setWorkers(list: WorkerSceneState[]): void;
  destroy(): void;
};

type SceneCallbacks = {
  onPositions(list: PersonScreenPos[]): void;
  onSelect(id: string): void;
  onAvatarError(id: string, message: string): void;
};

type PersonEntry = {
  person: Person;
  last: CharacterState | null;
  index: number;
  avatarId: string | null;
};

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

  const world = new Container();
  world.sortableChildren = true;

  const room = new Room();
  const furniture = new FurnitureLayer();
  const particles = new ParticleSystem();
  const personalDesks = new PersonalDeskLayer(callbacks.onSelect);
  const officeDecor = new OfficeDecor();

  room.container.zIndex = -1000;
  particles.g.zIndex = 10000;
  world.addChild(room.container, personalDesks.container, officeDecor.container, particles.g);
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

  function layout(): void {
    const w = app.screen.width;
    const h = app.screen.height;
    scale = Math.max(2, Math.floor(Math.min(w / ART_W, h / ART_H)));
    world.scale.set(scale);
    world.position.set(
      Math.floor((w - ART_W * scale) / 2),
      Math.floor((h - ART_H * scale) / 2),
    );
    for (const { def, text } of labels) {
      text.position.set(
        world.position.x + def.x * scale,
        world.position.y + (def.bottom + 3) * scale,
      );
    }
  }
  layout();
  app.renderer.on("resize", layout);

  const entries = new Map<string, PersonEntry>();
  let elapsed = 0;

  function standSpot(station: StationKey, index: number): { x: number; y: number } {
    if (station === "home") return personalDeskSpot(index, entries.size || 1);
    const def = furniture.def(station);
    const [ox, oy] = SPOT_OFFSETS[index % SPOT_OFFSETS.length];
    return {
      x: Math.max(8, Math.min(ART_W - 8, def.standX + ox)),
      y: Math.max(52, Math.min(ART_H - 6, def.standY + oy)),
    };
  }

  function applyCharacter(entry: PersonEntry, next: CharacterState): void {
    const prev = entry.last;
    entry.last = next;
    const { person, index } = entry;

    if (!prev || prev.station !== next.station) {
      const spot = standSpot(next.station, index);
      person.setTarget(spot.x, spot.y);
    }
    person.activity = next.activity;

    if (prev && next.bump !== prev.bump && next.mood !== "neutral") {
      const success = next.mood === "success";
      person.flash(success ? GREEN : RED, success);
      particles.burst(person.x, person.y - 8, success ? GREEN : RED, success ? 14 : 18, 0.045);
    }
  }

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS;
    elapsed += dt;

    room.update(elapsed);
    furniture.update(elapsed);
    particles.update(dt);

    const positions: PersonScreenPos[] = [];
    for (const [id, entry] of entries) {
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
      });
    }
    callbacks.onPositions(positions);
  });

  return {
    setWorkers(list: WorkerSceneState[]) {
      const permanentWorkers = list.filter((worker) => !worker.temporary);
      personalDesks.setWorkers(permanentWorkers);
      officeDecor.setWorkerCount(permanentWorkers.length);
      const seen = new Set<string>();
      let permanentIndex = 0;
      let temporaryIndex = 0;
      for (const w of list) {
        const workerIndex = w.temporary ? temporaryIndex++ : permanentIndex++;
        seen.add(w.id);
        let entry = entries.get(w.id);
        if (!entry) {
          const person = new Person(w.colorIndex);
          person.container.eventMode = "static";
          person.container.cursor = "pointer";
          person.container.hitArea = {
            contains: (x: number, y: number) => x >= -8 && x <= 8 && y >= -18 && y <= 2,
          };
          person.container.on("pointerdown", () => callbacks.onSelect(w.selectId));
          world.addChild(person.container);
          entry = { person, last: null, index: workerIndex, avatarId: null };
          entries.set(w.id, entry);
          const spot = standSpot(w.character.station, entry.index);
          person.x = spot.x;
          person.y = spot.y;
          person.setTarget(spot.x, spot.y);
        }
        entry.index = workerIndex;
        if (entry.avatarId !== w.avatarId) {
          entry.avatarId = w.avatarId;
          void entry.person
            .setAvatar(w.avatarId ? apiAssetUrl(`/api/avatars/${w.avatarId}`) : null)
            .then((message) => {
              if (message) callbacks.onAvatarError(w.selectId, message);
            });
        }
        entry.person.active = w.active;
        entry.person.container.alpha = w.temporary ? 0.88 : 1;
        if (entry.last !== w.character) applyCharacter(entry, w.character);
        if (w.character.station === "home") {
          const spot = personalDeskSpot(workerIndex, permanentWorkers.length);
          entry.person.setTarget(spot.x, spot.y);
        }
      }
      for (const [id, entry] of entries) {
        if (!seen.has(id)) {
          entry.person.destroy();
          entries.delete(id);
        }
      }

      const activeStations = new Set<StationKey>();
      for (const w of list) {
        if (!w.temporary && w.character.activity === "working") activeStations.add(w.character.station);
      }
      furniture.setActive(activeStations);
    },
    destroy() {
      app.renderer.off("resize", layout);
      for (const entry of entries.values()) entry.person.destroy();
      entries.clear();
      app.destroy(true, { children: true, texture: true });
    },
  };
}
